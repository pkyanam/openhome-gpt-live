import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 12_000;

export interface LocalWhisperTranscriberOptions {
  enabled?: boolean;
  executable?: string;
  modelPath?: string;
  timeoutMs?: number;
  run?: (command: readonly string[], timeoutMs: number) => Promise<string>;
}

/**
 * Narrow local STT used only to identify deterministic speaker-media commands.
 * Ordinary conversation and its transcript remain owned by GPT Live.
 */
export class LocalWhisperTranscriber {
  readonly configured: boolean;
  readonly executable?: string;
  readonly modelPath?: string;
  private readonly timeoutMs: number;
  private readonly run: (command: readonly string[], timeoutMs: number) => Promise<string>;

  constructor(options: LocalWhisperTranscriberOptions = {}) {
    const enabled = options.enabled ?? true;
    const executable = options.executable?.trim() || discoverExecutable();
    const modelPath = options.modelPath?.trim()
      ? resolve(options.modelPath.trim())
      : discoverModel();
    this.executable = executable;
    this.modelPath = modelPath;
    this.configured = Boolean(enabled && executable && modelPath && existsSync(modelPath));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = options.run ?? runCommand;
  }

  async transcribePcm16(pcm16: Uint8Array, sampleRate = 16_000): Promise<string> {
    if (!this.configured || !this.executable || !this.modelPath) {
      throw new Error("The local voice-command transcriber is not configured.");
    }
    if (sampleRate !== 16_000) throw new TypeError("Voice-command PCM must be 16 kHz.");
    if (pcm16.byteLength < sampleRate) {
      throw new TypeError("Voice-command audio is too short to transcribe reliably.");
    }
    if (pcm16.byteLength > sampleRate * 2 * 20) {
      throw new TypeError("Voice-command audio exceeds the 20-second limit.");
    }

    const directory = await mkdtemp(join(tmpdir(), "openhome-voice-command-"));
    const wavPath = join(directory, "request.wav");
    try {
      await writeFile(wavPath, pcm16Wav(pcm16, sampleRate), { mode: 0o600 });
      const output = await this.run([
        this.executable,
        "-m", this.modelPath,
        "-f", wavPath,
        "-l", "en",
        "-nt",
        "-np",
        "--prompt",
        "Wake names include Lara and Juniper. Spotify commands mention songs, artists, albums, playlists, play, pause, resume, skip, queue, volume, and now playing.",
      ], this.timeoutMs);
      const transcript = cleanTranscript(output);
      if (!transcript) throw new Error("The local transcriber returned no speech.");
      return transcript;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function pcm16Wav(pcm16: Uint8Array, sampleRate = 16_000): Uint8Array {
  if (pcm16.byteLength % 2 !== 0) throw new TypeError("PCM16 audio must contain whole samples.");
  const wav = new Uint8Array(44 + pcm16.byteLength);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + pcm16.byteLength, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, pcm16.byteLength, true);
  wav.set(pcm16, 44);
  return wav;
}

function cleanTranscript(value: string): string {
  return value
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,.;:!?\s]+|[,.;:!?\s]+$/g, "");
}

function discoverExecutable(): string | undefined {
  const resolved = typeof Bun.which === "function" ? Bun.which("whisper-cli") : null;
  if (resolved) return resolved;
  return ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
    .find((candidate) => existsSync(candidate));
}

function discoverModel(): string | undefined {
  const candidates = [
    resolve("data/models/ggml-base.en.bin"),
    resolve("data/models/ggml-small.en.bin"),
    resolve("data/models/ggml-tiny.en.bin"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function runCommand(command: readonly string[], timeoutMs: number): Promise<string> {
  const process = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => process.kill(), timeoutMs);
  try {
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]).then(([code, output]) => [code, output] as const);
    if (exitCode !== 0) throw new Error("Local voice transcription failed.");
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}
