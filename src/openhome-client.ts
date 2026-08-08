const DEFAULT_BASE_URL = "https://app.openhome.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 1_000_000;

export interface OpenHomeClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ToggleAbilityInput {
  installedCapabilityId: number;
  enabled: boolean;
  triggerWords: string[];
}

export class OpenHomeClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenHomeClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  listAgents(): Promise<unknown> {
    return this.request("/api/personalities/get-all-personalities/");
  }

  listAbilities(scope: "all" | "installed"): Promise<unknown> {
    const path = scope === "installed"
      ? "/api/capabilities/get-installed-capabilities/"
      : "/api/capabilities/get-all-capabilities/";
    return this.request(path);
  }

  toggleAbility(input: ToggleAbilityInput): Promise<unknown> {
    return this.request(
      `/api/capabilities/edit-installed-capability/${input.installedCapabilityId}/`,
      {
        method: "PUT",
        body: {
          enabled: input.enabled,
          trigger_words: input.triggerWords,
        },
      },
    );
  }

  private async request(
    path: string,
    options: { method?: "GET" | "PUT"; body?: unknown } = {},
  ): Promise<unknown> {
    if (!this.apiKey) {
      throw new Error("OpenHome tools are not configured. Set OPENHOME_API_KEY on the server.");
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        "x-api-key": this.apiKey,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new Error("OpenHome returned a response larger than the configured safety limit.");
    }
    const payload = parseJson(text);
    if (!response.ok) {
      throw new Error(`OpenHome request failed (${response.status}): ${errorDetail(payload)}`);
    }
    return payload;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new TypeError("OPENHOME_API_BASE must use HTTPS unless it points to localhost.");
  }
  return url.toString().replace(/\/+$/, "");
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("OpenHome returned a non-JSON response.");
  }
}

function errorDetail(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "unknown error";
  const record = payload as Record<string, unknown>;
  for (const key of ["message", "detail", "error"]) {
    if (typeof record[key] === "string") return record[key].slice(0, 300);
  }
  return "unknown error";
}
