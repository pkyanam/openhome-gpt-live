export interface OpenHomeSpotifyClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface SpotifyAbilityEvent {
  type?: string;
  message?: string;
}

interface SpotifyAbilityRequest {
  status?: string;
  events?: SpotifyAbilityEvent[];
  error?: { message?: string };
}

/** Optional, narrowly scoped client for the separate openhome-spotify service. */
export class OpenHomeSpotifyClient {
  readonly configured: boolean;
  private readonly baseUrl?: string;
  private readonly token?: string;
  private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(options: OpenHomeSpotifyClientOptions = {}) {
    const baseUrl = options.baseUrl?.trim();
    const token = options.token?.trim();
    if (Boolean(baseUrl) !== Boolean(token)) {
      throw new Error("OPENHOME_SPOTIFY_URL and OPENHOME_SPOTIFY_TOOL_TOKEN must be configured together.");
    }
    if (baseUrl) this.baseUrl = validateBaseUrl(baseUrl);
    if (token) this.token = token;
    this.configured = Boolean(this.baseUrl && this.token);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async executeVoice(transcript: string, requestId: string): Promise<string> {
    if (!this.baseUrl || !this.token) throw new Error("Spotify is not configured for this speaker.");
    const accepted = await this.request("/v1/voice/execute", {
      method: "POST",
      body: JSON.stringify({ transcript, requestId, ownerId: "openhome-gpt-live" }),
    });
    const terminal = terminalMessage(accepted);
    if (terminal) return terminal;

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await delay(this.pollIntervalMs);
      const record = await this.request(`/v1/requests/${encodeURIComponent(requestId)}`);
      const result = terminalMessage(record);
      if (result) return result;
    }
    throw new Error("Spotify accepted the request but did not confirm it in time.");
  }

  private async request(path: string, init: RequestInit = {}): Promise<SpotifyAbilityRequest> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const value = await response.json().catch(() => ({})) as SpotifyAbilityRequest;
    if (!response.ok) {
      throw new Error(publicMessage(value.error?.message, `Spotify returned HTTP ${response.status}.`));
    }
    return value;
  }
}

function terminalMessage(record: SpotifyAbilityRequest): string | undefined {
  if (record.status !== "completed" && record.status !== "failed") return undefined;
  const events = Array.isArray(record.events) ? record.events : [];
  const event = [...events].reverse().find((candidate) =>
    candidate.type === "spotify.completion" || candidate.type === "spotify.error"
  );
  const fallback = record.status === "completed"
    ? "Spotify completed the request."
    : "I couldn’t complete that Spotify request. Please try again.";
  const message = publicMessage(event?.message, fallback);
  if (record.status === "failed") throw new Error(message);
  return message;
}

function publicMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized && normalized.length <= 400 ? normalized : fallback;
}

function validateBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OPENHOME_SPOTIFY_URL must use HTTPS unless it is loopback.");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("OPENHOME_SPOTIFY_URL must be an origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
