import { describe, expect, test } from "bun:test";
import { LocalWhisperTranscriber, pcm16Wav } from "./local-transcriber.ts";

describe("LocalWhisperTranscriber", () => {
  test("wraps mono PCM16 in a valid WAV container", () => {
    const wav = pcm16Wav(new Uint8Array([1, 2, 3, 4]));
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(4);
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4]);
  });

  test("uses the configured local model and cleans the transcript", async () => {
    let command: readonly string[] = [];
    const transcriber = new LocalWhisperTranscriber({
      executable: "/bin/echo",
      modelPath: "/dev/null",
      run: async (value) => {
        command = value;
        return "  Lara, play Dreams by Fleetwood Mac.  \n";
      },
    });
    const transcript = await transcriber.transcribePcm16(new Uint8Array(16_000));
    expect(transcript).toBe("Lara, play Dreams by Fleetwood Mac");
    expect(command).toContain("/dev/null");
  });

  test("rejects audio outside the safe duration range", async () => {
    const transcriber = new LocalWhisperTranscriber({
      executable: "/bin/echo",
      modelPath: "/dev/null",
      run: async () => "unused",
    });
    await expect(transcriber.transcribePcm16(new Uint8Array(100))).rejects.toThrow("too short");
  });
});
