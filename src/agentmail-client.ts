const DEFAULT_BASE_URL = "https://api.agentmail.to";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_SUBJECT_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;

export interface AgentMailClientOptions {
  apiKey?: string;
  inbox?: string;
  baseUrl?: string;
  fetch?: AgentMailFetch;
  timeoutMs?: number;
}

export type AgentMailFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AgentMailInbox {
  inboxId: string;
  email: string;
  displayName?: string;
}

export interface AgentMailMessageInput {
  to: string;
  subject: string;
  text: string;
}

export interface AgentMailSendResult {
  messageId: string;
  threadId: string;
}

export class AgentMailClient {
  readonly configured: boolean;
  readonly senderAddress?: string;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly request: AgentMailFetch;
  private readonly timeoutMs: number;

  constructor(options: AgentMailClientOptions = {}) {
    const apiKey = options.apiKey?.trim() || undefined;
    const inbox = options.inbox?.trim() || undefined;
    if (Boolean(apiKey) !== Boolean(inbox)) {
      throw new TypeError("AGENTMAIL_API_KEY and AGENTMAIL_INBOX must be configured together.");
    }

    this.baseUrl = normalizeBaseUrl(options.baseUrl?.trim() || DEFAULT_BASE_URL);
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new TypeError("AgentMail timeout must be between 1 and 60000 milliseconds.");
    }

    this.apiKey = apiKey;
    this.senderAddress = inbox ? validateEmail(inbox, "AgentMail inbox") : undefined;
    this.configured = Boolean(this.apiKey && this.senderAddress);
  }

  async verifyInbox(): Promise<AgentMailInbox> {
    const { apiKey, inbox } = this.requireConfiguration();
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/v0/inboxes/${encodeURIComponent(inbox)}`,
      { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } },
      "verify",
    );
    if (!response.ok) {
      if (response.status === 403) {
        const scope = await this.credentialScope(apiKey);
        if (scope.type === "inbox") {
          if (scope.inboxId.toLowerCase() !== inbox.toLowerCase()) {
            throw new Error("The AgentMail API key is scoped to a different inbox than the selected sender address.");
          }
          return { inboxId: scope.inboxId, email: inbox };
        }
        throw new Error(
          `The ${scope.type}-scoped AgentMail API key needs inbox_read to validate the selected sender address.`,
        );
      }
      throw agentMailHttpError(response.status, "verify");
    }
    const payload = await safeJson(response);
    const email = readString(payload, "email");
    const inboxId = readString(payload, "inbox_id");
    if (email.toLowerCase() !== inbox.toLowerCase()) {
      throw new Error("AgentMail returned a different inbox than the configured sender address.");
    }
    const displayName = optionalString(payload, "display_name");
    return { inboxId, email, ...(displayName ? { displayName } : {}) };
  }

  private async credentialScope(apiKey: string): Promise<
    | { type: "inbox"; inboxId: string }
    | { type: "organization" | "pod" }
  > {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/v0/auth/me`,
      { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } },
      "verify",
    );
    if (!response.ok) throw agentMailHttpError(response.status, "verify");
    const payload = await safeJson(response);
    const scopeType = readString(payload, "scope_type");
    if (scopeType === "inbox") {
      return { type: scopeType, inboxId: readString(payload, "inbox_id") };
    }
    if (scopeType === "organization" || scopeType === "pod") return { type: scopeType };
    throw new Error("AgentMail returned an invalid credential scope.");
  }

  async sendMessage(
    input: AgentMailMessageInput,
    idempotencyKey: string,
  ): Promise<AgentMailSendResult> {
    const { apiKey, inbox } = this.requireConfiguration();
    const message = validateMessage(input);
    if (!/^[A-Za-z0-9._~-]{1,256}$/.test(idempotencyKey)) {
      throw new TypeError("AgentMail idempotency key is invalid.");
    }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      },
      "send",
    );
    if (!response.ok) throw agentMailHttpError(response.status, "send");
    const payload = await safeJson(response);
    return {
      messageId: readString(payload, "message_id"),
      threadId: readString(payload, "thread_id"),
    };
  }

  private requireConfiguration(): { apiKey: string; inbox: string } {
    if (!this.apiKey || !this.senderAddress) {
      throw new Error("AgentMail is not configured for this speaker.");
    }
    return { apiKey: this.apiKey, inbox: this.senderAddress };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    operation: "verify" | "send",
  ): Promise<Response> {
    try {
      return await this.request(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error(operation === "send"
        ? "AgentMail did not confirm the email send. Please check the AgentMail inbox before trying again."
        : "AgentMail did not respond while validating the configured inbox.");
    }
  }
}

function validateMessage(input: AgentMailMessageInput): AgentMailMessageInput {
  const to = validateEmail(input.to, "Recipient");
  const subject = input.subject.trim();
  const text = input.text.trim();
  if (!subject || subject.length > MAX_SUBJECT_LENGTH || /[\r\n]/.test(subject)) {
    throw new TypeError(`Email subject must contain 1-${MAX_SUBJECT_LENGTH} characters on one line.`);
  }
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`Email body must contain 1-${MAX_TEXT_LENGTH} characters.`);
  }
  return { to, subject, text };
}

function validateEmail(value: string, label: string): string {
  const email = value.trim();
  if (
    email.length > 320
    || /[\r\n<>,;:\s]/.test(email)
    || !/^[^@]+@[^@]+\.[^@]+$/.test(email)
  ) {
    throw new TypeError(`${label} must be one valid email address.`);
  }
  return email;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new TypeError("AgentMail API base must use HTTPS unless it is loopback.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("AgentMail API base must be an origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

function agentMailHttpError(status: number, operation: "verify" | "send"): Error {
  if (status === 401) return new Error("The AgentMail API key is invalid or expired.");
  if (status === 403) {
    return new Error(operation === "send"
      ? "AgentMail rejected the email. Check the API key's inbox scope, message_send permission, and recipient policy."
      : "The AgentMail API key cannot validate the selected inbox. Grant inbox_read or use a message_send key scoped to that exact inbox.");
  }
  if (status === 404) return new Error("The selected AgentMail inbox was not found.");
  if (status === 409) return new Error("AgentMail rejected a conflicting duplicate-send key.");
  if (status === 429) return new Error("AgentMail is rate limiting email sends. Please try again later.");
  if (status >= 500) return new Error("AgentMail is temporarily unavailable.");
  return new Error(operation === "send"
    ? `AgentMail rejected the email request (HTTP ${status}).`
    : `AgentMail could not validate the selected inbox (HTTP ${status}).`);
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new Error("AgentMail returned an invalid response.");
  }
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("AgentMail returned an incomplete response.");
  }
  return value.trim();
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
