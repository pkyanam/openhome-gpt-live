import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { JsonFileStore } from "./file-store.ts";

const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_CONFIRMATIONS = 20;

export type DeviceLoginStatus =
  | "unauthenticated"
  | "pending"
  | "authenticated"
  | "expired"
  | "error";

export interface PendingDeviceConfirmation {
  callId: string;
  name: string;
  review: unknown;
}

export interface DeviceRecord {
  id: string;
  name: string;
  deviceTokenHash: string;
  pairingCodeHash?: string;
  pairingExpiresAt?: number;
  claimTokenHash?: string;
  lwcCookie?: string;
  loginStatus: DeviceLoginStatus;
  loginUser?: { email?: string; name?: string; plan?: string };
  userCode?: string;
  verificationUrl?: string;
  loginExpiresAt?: number;
  liveSessionId?: string;
  selectedModel?: string;
  voice?: string;
  wakePhrase?: string;
  connectionState?: string;
  codexState?: "idle" | "working";
  codexQueueDepth?: number;
  lastCodexTaskStatus?: "completed" | "failed" | "interrupted";
  lastCodexTaskAt?: number;
  lastVoiceRoute?: "native" | "openai_search" | "codex";
  lastVoiceRouteAt?: number;
  pendingConfirmations: PendingDeviceConfirmation[];
  lastError?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface DeviceRegistration {
  record: DeviceRecord;
  deviceToken: string;
  pairingCode?: string;
}

export interface PublicDeviceSession {
  deviceId: string;
  name: string;
  paired: boolean;
  loginStatus: DeviceLoginStatus;
  loginUser?: DeviceRecord["loginUser"];
  userCode?: string;
  verificationUrl?: string;
  loginExpiresAt?: number;
  liveSessionId?: string;
  selectedModel?: string;
  voice?: string;
  wakePhrase?: string;
  connectionState?: string;
  codexState?: "idle" | "working";
  codexQueueDepth?: number;
  lastCodexTaskStatus?: "completed" | "failed" | "interrupted";
  lastCodexTaskAt?: number;
  lastVoiceRoute?: "native" | "openai_search" | "codex";
  lastVoiceRouteAt?: number;
  pendingConfirmations: PendingDeviceConfirmation[];
  lastError?: string;
  lastSeenAt: number;
}

export class DeviceRegistry {
  private readonly updateQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: JsonFileStore<DeviceRecord>,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  async register(
    name: string,
    resume?: { deviceId: string; deviceToken: string },
    initialVoice = "vale",
    initialWakePhrase = "juniper",
  ): Promise<DeviceRegistration> {
    if (resume) {
      let existing = await this.authenticateDevice(resume.deviceId, resume.deviceToken);
      if (!existing.voice || !existing.wakePhrase) {
        existing = await this.update(existing.id, (record) => {
          if (!record.voice) record.voice = initialVoice;
          if (!record.wakePhrase) record.wakePhrase = initialWakePhrase;
        });
      }
      const pairing = existing.claimTokenHash ? undefined : await this.issuePairing(existing.id);
      return {
        record: (await this.get(existing.id))!,
        deviceToken: resume.deviceToken,
        pairingCode: pairing,
      };
    }

    const deviceToken = randomToken();
    const id = `dev_${randomBytes(12).toString("base64url")}`;
    const record: DeviceRecord = {
      id,
      name: normalizeName(name),
      deviceTokenHash: this.hash("device", deviceToken),
      loginStatus: "unauthenticated",
      voice: initialVoice,
      wakePhrase: initialWakePhrase,
      pendingConfirmations: [],
      createdAt: this.now(),
      lastSeenAt: this.now(),
    };
    await this.save(record);
    const pairingCode = await this.issuePairing(id);
    return { record: (await this.get(id))!, deviceToken, pairingCode };
  }

  async get(id: string): Promise<DeviceRecord | undefined> {
    return this.store.get(id);
  }

  async update(id: string, mutate: (record: DeviceRecord) => void): Promise<DeviceRecord> {
    const previous = this.updateQueues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const record = await this.get(id);
      if (!record) throw new Error("Device session not found.");
      mutate(record);
      record.lastSeenAt = this.now();
      await this.save(record);
      return record;
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.updateQueues.set(id, tail);
    try {
      return await operation;
    } finally {
      if (this.updateQueues.get(id) === tail) this.updateQueues.delete(id);
    }
  }

  async authenticateDevice(id: string, token: string): Promise<DeviceRecord> {
    const record = await this.get(id);
    if (!record || !safeEqual(record.deviceTokenHash, this.hash("device", token))) {
      throw new Error("Device authentication failed.");
    }
    return this.update(id, () => {});
  }

  async issuePairing(id: string): Promise<string> {
    const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    await this.update(id, (record) => {
      record.pairingCodeHash = this.hash("pairing", code);
      record.pairingExpiresAt = this.now() + PAIRING_TTL_MS;
    });
    return code;
  }

  async claim(code: string): Promise<{ record: DeviceRecord; claimToken: string }> {
    const normalized = normalizePairingCode(code);
    const targetHash = this.hash("pairing", normalized);
    const entry = (await this.store.entries()).find(([, record]) =>
      record.pairingCodeHash
      && record.pairingExpiresAt !== undefined
      && record.pairingExpiresAt > this.now()
      && safeEqual(record.pairingCodeHash, targetHash));
    if (!entry) throw new Error("Pairing code is invalid or expired.");

    const claimToken = randomToken();
    const record = await this.update(entry[0], (current) => {
      if (
        !current.pairingCodeHash
        || current.pairingExpiresAt === undefined
        || current.pairingExpiresAt <= this.now()
        || !safeEqual(current.pairingCodeHash, targetHash)
      ) {
        throw new Error("Pairing code is invalid or expired.");
      }
      current.claimTokenHash = this.hash("claim", claimToken);
      delete current.pairingCodeHash;
      delete current.pairingExpiresAt;
    });
    return { record, claimToken };
  }

  async authenticateClaim(cookieValue: string | undefined): Promise<DeviceRecord> {
    const parsed = parseClaimCookie(cookieValue);
    if (!parsed) throw new Error("Pairing session is not authenticated.");
    const record = await this.get(parsed.deviceId);
    if (!record?.claimTokenHash || !safeEqual(record.claimTokenHash, this.hash("claim", parsed.token))) {
      throw new Error("Pairing session is not authenticated.");
    }
    return record;
  }

  async observeBridgeEvent(id: string, event: unknown): Promise<void> {
    if (!isRecord(event) || typeof event["type"] !== "string") return;
    await this.update(id, (record) => {
      switch (event["type"]) {
        case "session.started":
          record.connectionState = "live";
          record.codexState = "idle";
          record.codexQueueDepth = 0;
          delete record.lastError;
          break;
        case "session.closed":
          record.connectionState = "closed";
          record.codexState = "idle";
          record.codexQueueDepth = 0;
          delete record.liveSessionId;
          record.pendingConfirmations = [];
          break;
        case "handoff.started":
          record.lastVoiceRoute = "codex";
          record.lastVoiceRouteAt = this.now();
          record.codexState = "working";
          if (event["queued"] === true) {
            record.codexQueueDepth = Math.max(0, (record.codexQueueDepth ?? 0) - 1);
          }
          break;
        case "handoff.redirected":
          if (event["destination"] === "native") {
            record.lastVoiceRoute = "native";
            record.lastVoiceRouteAt = this.now();
          }
          break;
        case "search.started":
          record.lastVoiceRoute = "openai_search";
          record.lastVoiceRouteAt = this.now();
          break;
        case "handoff.queued":
          record.codexState = "working";
          if (typeof event["position"] === "number") {
            record.codexQueueDepth = Math.max(0, Math.floor(event["position"]));
          }
          break;
        case "handoff.completed": {
          const status = event["status"];
          if (status === "completed" || status === "failed" || status === "interrupted") {
            record.lastCodexTaskStatus = status;
            record.lastCodexTaskAt = this.now();
          }
          record.codexState = (record.codexQueueDepth ?? 0) > 0 ? "working" : "idle";
          break;
        }
        case "tool.pending_confirmation": {
          const callId = event["callId"];
          const name = event["name"];
          if (typeof callId !== "string" || typeof name !== "string" || !("review" in event)) break;
          record.pendingConfirmations = [
            ...record.pendingConfirmations.filter((item) => item.callId !== callId),
            { callId, name, review: event["review"] },
          ].slice(-MAX_PENDING_CONFIRMATIONS);
          break;
        }
        case "tool.completed":
        case "tool.failed": {
          const callId = event["callId"];
          if (typeof callId === "string") {
            record.pendingConfirmations = record.pendingConfirmations.filter((item) => item.callId !== callId);
          }
          if (event["type"] === "tool.failed" && typeof event["message"] === "string") {
            record.lastError = event["message"].slice(0, 500);
          }
          break;
        }
        case "error":
          if (typeof event["message"] === "string") record.lastError = event["message"].slice(0, 500);
          break;
      }
    });
  }

  publicSession(record: DeviceRecord): PublicDeviceSession {
    return {
      deviceId: record.id,
      name: record.name,
      paired: Boolean(record.claimTokenHash),
      loginStatus: record.loginStatus,
      ...(record.loginUser ? { loginUser: record.loginUser } : {}),
      ...(record.userCode ? { userCode: record.userCode } : {}),
      ...(record.verificationUrl ? { verificationUrl: record.verificationUrl } : {}),
      ...(record.loginExpiresAt ? { loginExpiresAt: record.loginExpiresAt } : {}),
      ...(record.liveSessionId ? { liveSessionId: record.liveSessionId } : {}),
      ...(record.selectedModel ? { selectedModel: record.selectedModel } : {}),
      ...(record.voice ? { voice: record.voice } : {}),
      ...(record.wakePhrase ? { wakePhrase: record.wakePhrase } : {}),
      ...(record.connectionState ? { connectionState: record.connectionState } : {}),
      ...(record.codexState ? { codexState: record.codexState } : {}),
      ...(record.codexQueueDepth !== undefined ? { codexQueueDepth: record.codexQueueDepth } : {}),
      ...(record.lastCodexTaskStatus ? { lastCodexTaskStatus: record.lastCodexTaskStatus } : {}),
      ...(record.lastCodexTaskAt !== undefined ? { lastCodexTaskAt: record.lastCodexTaskAt } : {}),
      ...(record.lastVoiceRoute ? { lastVoiceRoute: record.lastVoiceRoute } : {}),
      ...(record.lastVoiceRouteAt !== undefined ? { lastVoiceRouteAt: record.lastVoiceRouteAt } : {}),
      pendingConfirmations: structuredClone(record.pendingConfirmations),
      ...(record.lastError ? { lastError: record.lastError } : {}),
      lastSeenAt: record.lastSeenAt,
    };
  }

  private save(record: DeviceRecord): Promise<void> {
    return this.store.set(record.id, record, { ttlMs: DEVICE_TTL_MS });
  }

  private hash(namespace: string, value: string): string {
    return createHmac("sha256", this.secret).update(`${namespace}\0${value}`).digest("base64url");
  }
}

export function pairingCookieValue(deviceId: string, claimToken: string): string {
  return `${deviceId}.${claimToken}`;
}

function parseClaimCookie(value: string | undefined): { deviceId: string; token: string } | undefined {
  if (!value) return undefined;
  const split = value.indexOf(".");
  if (split < 1) return undefined;
  const deviceId = value.slice(0, split);
  const token = value.slice(split + 1);
  return deviceId.startsWith("dev_") && token.length >= 32 ? { deviceId, token } : undefined;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeName(value: string): string {
  const normalized = value.trim().slice(0, 80);
  return normalized || "OpenHome DevKit";
}

function normalizePairingCode(value: string): string {
  const normalized = value.replace(/\D/g, "");
  if (!/^\d{8}$/.test(normalized)) throw new Error("Pairing code must contain eight digits.");
  return normalized;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
