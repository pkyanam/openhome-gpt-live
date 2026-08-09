import { timingSafeEqual } from "node:crypto";
import {
  readCookie,
  serializeCookie,
  type ChatGPTHandler,
} from "@opencoredev/loginwithchatgpt-server";
import { CHATGPT_REALTIME_VOICES } from "@opencoredev/loginwithchatgpt-core";
import {
  DeviceRegistry,
  pairingCookieValue,
  type DeviceRecord,
} from "./device-registry.ts";
import type { PairingCodeStore } from "./pairing-code-store.ts";

const PAIRING_COOKIE = "ohgpt_pairing";
const MAX_JSON_BODY_BYTES = 512 * 1024;
const CLAIM_LIMIT = 20;
const CLAIM_WINDOW_MS = 60_000;
const BRIDGE_KEEPALIVE_MS = 5_000;

export interface DeviceRoutesOptions {
  auth: ChatGPTHandler;
  registry: DeviceRegistry;
  bootstrapToken: string;
  publicBaseUrl?: string;
  pairingCodes?: PairingCodeStore;
}

export function createDeviceRoutes(options: DeviceRoutesOptions) {
  const claimAttempts: number[] = [];

  return async function handleDeviceRoute(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/device/register" && request.method === "POST") {
      if (!validSecret(readBearer(request), options.bootstrapToken)) {
        return json({ error: "device_bootstrap_unauthorized" }, { status: 401 });
      }
      const payload = await readJson(request);
      if (payload instanceof Response) return payload;
      const name = typeof payload["name"] === "string" ? payload["name"] : "OpenHome DevKit";
      const initialVoice = normalizeVoice(payload["voice"] ?? "vale");
      if (!initialVoice) return json({ error: "invalid_voice" }, { status: 400 });
      const initialWakePhrase = normalizeWakePhrase(payload["wakePhrase"] ?? "juniper");
      if (!initialWakePhrase) return json({ error: "invalid_wake_phrase" }, { status: 400 });
      const deviceId = payload["deviceId"];
      const deviceToken = payload["deviceToken"];
      const resume = typeof deviceId === "string" && typeof deviceToken === "string"
        ? { deviceId, deviceToken }
        : undefined;
      try {
        const registration = await options.registry.register(
          name,
          resume,
          initialVoice,
          initialWakePhrase,
        );
        const publicBaseUrl = resolvePublicBaseUrl(request, options.publicBaseUrl);
        if (registration.pairingCode && options.pairingCodes) {
          await options.pairingCodes.record({
            deviceId: registration.record.id,
            deviceName: registration.record.name,
            code: registration.pairingCode,
            setupUrl: `${publicBaseUrl}/setup`,
          });
        }
        return json({
          deviceId: registration.record.id,
          deviceToken: registration.deviceToken,
          ...(registration.pairingCode ? { pairingCode: registration.pairingCode } : {}),
          setupUrl: `${publicBaseUrl}/setup`,
          session: options.registry.publicSession(registration.record),
        });
      } catch (error) {
        return json({ error: "device_registration_failed", message: publicError(error) }, { status: 401 });
      }
    }

    const resetMatch = /^\/api\/device\/([^/]+)\/pairing\/reset$/.exec(path);
    if (resetMatch && request.method === "POST") {
      try {
        const record = await authenticateDeviceRequest(options.registry, resetMatch[1]!, request);
        const pairingCode = await options.registry.issuePairing(record.id);
        const setupUrl = `${resolvePublicBaseUrl(request, options.publicBaseUrl)}/setup`;
        await options.pairingCodes?.record({
          deviceId: record.id,
          deviceName: record.name,
          code: pairingCode,
          setupUrl,
        });
        return json({
          pairingCode,
          setupUrl,
        });
      } catch (error) {
        return json({ error: "device_unauthorized", message: publicError(error) }, { status: 401 });
      }
    }

    const settingsMatch = /^\/api\/device\/([^/]+)\/settings$/.exec(path);
    if (settingsMatch && request.method === "GET") {
      try {
        const record = await authenticateDeviceRequest(options.registry, settingsMatch[1]!, request);
        return json({
          voice: normalizeVoice(record.voice) ?? "vale",
          wakePhrase: normalizeWakePhrase(record.wakePhrase) ?? "juniper",
        });
      } catch (error) {
        return json({ error: "device_unauthorized", message: publicError(error) }, { status: 401 });
      }
    }

    const proxyMatch = /^\/api\/device\/([^/]+)\/chatgpt(\/.*)$/.exec(path);
    if (proxyMatch) {
      try {
        const record = await authenticateDeviceRequest(options.registry, proxyMatch[1]!, request);
        return await proxyDeviceChatGPT(options, record, proxyMatch[2]!, request);
      } catch (error) {
        return json({ error: "device_unauthorized", message: publicError(error) }, { status: 401 });
      }
    }

    if (path === "/api/pairing/claim" && request.method === "POST") {
      const now = Date.now();
      while (claimAttempts[0] !== undefined && claimAttempts[0] <= now - CLAIM_WINDOW_MS) claimAttempts.shift();
      if (claimAttempts.length >= CLAIM_LIMIT) {
        return json({ error: "pairing_rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
      }
      claimAttempts.push(now);
      const payload = await readJson(request);
      if (payload instanceof Response) return payload;
      try {
        const { record, claimToken } = await options.registry.claim(String(payload["code"] ?? ""));
        await options.pairingCodes?.remove(record.id);
        const headers = new Headers();
        headers.set("set-cookie", serializeCookie(
          PAIRING_COOKIE,
          pairingCookieValue(record.id, claimToken),
          {
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
            secure: isSecureRequest(request, options.publicBaseUrl),
            maxAge: 30 * 24 * 60 * 60,
          },
        ));
        return json({ session: options.registry.publicSession(record) }, { headers });
      } catch (error) {
        return json({ error: "pairing_failed", message: publicError(error) }, { status: 400 });
      }
    }

    if (path === "/api/pairing/session" && request.method === "GET") {
      try {
        const record = await authenticatePairingRequest(options.registry, request);
        return json({ session: options.registry.publicSession(record) });
      } catch {
        return json({ error: "pairing_not_authenticated" }, { status: 401 });
      }
    }

    if (path === "/api/pairing/invite" && request.method === "POST") {
      try {
        const record = await authenticatePairingRequest(options.registry, request);
        const pairingCode = await options.registry.issuePairing(record.id);
        const setupUrl = `${resolvePublicBaseUrl(request, options.publicBaseUrl)}/setup`;
        await options.pairingCodes?.record({
          deviceId: record.id,
          deviceName: record.name,
          code: pairingCode,
          setupUrl,
        });
        const updated = await options.registry.get(record.id);
        return json({
          pairingCode,
          setupUrl,
          expiresAt: updated?.pairingExpiresAt,
        });
      } catch {
        return json({ error: "pairing_not_authenticated" }, { status: 401 });
      }
    }

    if (
      (path === "/api/pairing/settings" || path === "/api/pairing/voice")
      && request.method === "POST"
    ) {
      try {
        let record = await authenticatePairingRequest(options.registry, request);
        const payload = await readJson(request);
        if (payload instanceof Response) return payload;
        const voice = normalizeVoice(payload["voice"]);
        if (!voice) return json({ error: "invalid_voice" }, { status: 400 });
        const wakePhrase = path === "/api/pairing/settings"
          ? normalizeWakePhrase(payload["wakePhrase"])
          : normalizeWakePhrase(record.wakePhrase) ?? "juniper";
        if (!wakePhrase) {
          return json({
            error: "invalid_wake_phrase",
            message: "Use 1–40 English letters, spaces, or hyphens for the wake name.",
          }, { status: 400 });
        }
        if (record.codexState === "working") {
          return json({
            error: "codex_task_active",
            message: "Wait for active Codex tasks to finish before changing GPT Live settings.",
          }, { status: 409 });
        }
        const liveSessionId = record.liveSessionId;
        record = await options.registry.update(record.id, (current) => {
          current.voice = voice;
          current.wakePhrase = wakePhrase;
        });
        let reconnecting = false;
        if (liveSessionId && record.lwcCookie) {
          const closeResponse = await internalAuthRequest(options.auth, record, request, {
            path: `/realtime/app-server/${encodeURIComponent(liveSessionId)}`,
            method: "DELETE",
          });
          reconnecting = closeResponse.ok;
          if (closeResponse.ok) {
            record = await options.registry.update(record.id, (current) => {
              delete current.liveSessionId;
              current.connectionState = "reconnecting";
              current.codexState = "idle";
              current.codexActiveTasks = 0;
              current.codexQueueDepth = 0;
              current.pendingConfirmations = [];
            });
          }
        }
        return json({ session: options.registry.publicSession(record), reconnecting });
      } catch (error) {
        return json({ error: "settings_update_failed", message: publicError(error) }, { status: 400 });
      }
    }

    if (path === "/api/pairing/confirm" && request.method === "POST") {
      const payload = await readJson(request);
      if (payload instanceof Response) return payload;
      const callId = payload["callId"];
      const approved = payload["approved"];
      if (typeof callId !== "string" || typeof approved !== "boolean") {
        return json({ error: "invalid_confirmation" }, { status: 400 });
      }
      try {
        const record = await authenticatePairingRequest(options.registry, request);
        if (!record.liveSessionId || !record.lwcCookie) {
          return json({ error: "live_session_not_found" }, { status: 409 });
        }
        if (!record.pendingConfirmations.some((item) => item.callId === callId)) {
          return json({ error: "confirmation_not_pending" }, { status: 409 });
        }
        const response = await internalAuthRequest(options.auth, record, request, {
          path: `/realtime/app-server/${encodeURIComponent(record.liveSessionId)}/confirm`,
          method: "POST",
          body: JSON.stringify({ callId, confirmation: { approved } }),
          contentType: "application/json",
        });
        const result = await cloneWithoutSetCookie(response);
        if (response.ok) {
          await options.registry.update(record.id, (current) => {
            current.pendingConfirmations = current.pendingConfirmations.filter((item) => item.callId !== callId);
          });
        }
        return result;
      } catch (error) {
        return json({ error: "confirmation_failed", message: publicError(error) }, { status: 401 });
      }
    }

    return new Response("Not found", { status: 404 });
  };
}

async function proxyDeviceChatGPT(
  options: DeviceRoutesOptions,
  record: DeviceRecord,
  subpath: string,
  request: Request,
): Promise<Response> {
  if (!isAllowedDeviceRoute(subpath, request.method)) {
    return json({ error: "device_route_not_allowed" }, { status: 403 });
  }
  const bodyBytes = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await readBoundedBody(request);
  if (bodyBytes instanceof Response) return bodyBytes;
  const bodyText = enforceServerOwnedDeviceSettings(
    record,
    subpath,
    request.method,
    bodyBytes ? new TextDecoder().decode(bodyBytes) : undefined,
  );
  const response = await internalAuthRequest(options.auth, record, request, {
    path: subpath,
    method: request.method,
    body: bodyText,
    contentType: request.headers.get("content-type") ?? undefined,
    accept: request.headers.get("accept") ?? undefined,
  });

  const setCookie = response.headers.get("set-cookie");
  const lwcCookie = setCookie ? extractCookie(setCookie, "lwc_session") : undefined;
  if (lwcCookie) {
    record = await options.registry.update(record.id, (current) => {
      current.lwcCookie = `lwc_session=${lwcCookie}`;
    });
  }

  if (/^\/realtime\/app-server\/[^/]+\/events$/.test(subpath) && response.ok && response.body) {
    const [clientBody, observerBody] = response.body.tee();
    void monitorBridgeEvents(observerBody, record.id, options.registry);
    const headers = responseHeaders(response);
    return new Response(keepAliveNdjson(clientBody), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const payload = parseJsonBytes(bytes);
  await updateDeviceFromAuthResponse(options.registry, record.id, subpath, request.method, payload, bodyText, response.ok);
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  });
}

/** Keep Bun and intermediary HTTP connections alive while no tool events occur. */
export function keepAliveNdjson(
  stream: ReadableStream<Uint8Array>,
  intervalMs = BRIDGE_KEEPALIVE_MS,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const finish = () => {
    closed = true;
    if (interval !== undefined) clearInterval(interval);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      interval = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode("\n"));
      }, intervalMs);

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          finish();
          controller.close();
        } catch (error) {
          finish();
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      })();
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}

async function updateDeviceFromAuthResponse(
  registry: DeviceRegistry,
  deviceId: string,
  subpath: string,
  method: string,
  payload: unknown,
  requestBody: string | undefined,
  ok: boolean,
): Promise<void> {
  if (!isRecord(payload)) return;
  if (subpath === "/login" || subpath === "/status" || subpath === "/session") {
    const status = payload["status"];
    if (typeof status !== "string") return;
    await registry.update(deviceId, (record) => {
      if (["unauthenticated", "pending", "authenticated", "expired", "error"].includes(status)) {
        record.loginStatus = status as DeviceRecord["loginStatus"];
      }
      const user = payload["user"];
      if (isRecord(user)) {
        record.loginUser = {
          ...(typeof user["email"] === "string" ? { email: user["email"] } : {}),
          ...(typeof user["name"] === "string" ? { name: user["name"] } : {}),
          ...(typeof user["plan"] === "string" ? { plan: user["plan"] } : {}),
        };
      }
      if (typeof payload["userCode"] === "string") record.userCode = payload["userCode"];
      if (typeof payload["verificationUrl"] === "string") record.verificationUrl = payload["verificationUrl"];
      if (typeof payload["expiresAt"] === "number") record.loginExpiresAt = payload["expiresAt"];
      if (status === "authenticated") {
        delete record.userCode;
        delete record.verificationUrl;
        delete record.loginExpiresAt;
        delete record.lastError;
      }
    });
  }
  if (subpath === "/realtime/app-server" && method === "POST" && ok) {
    const sessionId = payload["sessionId"];
    if (typeof sessionId !== "string") return;
    const requested = requestBody ? parseJsonText(requestBody) : undefined;
    const session = isRecord(requested) && isRecord(requested["session"]) ? requested["session"] : undefined;
    await registry.update(deviceId, (record) => {
      record.liveSessionId = sessionId;
      record.connectionState = "connecting";
      record.codexState = "idle";
      record.codexActiveTasks = 0;
      record.codexQueueDepth = 0;
      if (typeof session?.["model"] === "string") record.selectedModel = session["model"];
      record.pendingConfirmations = [];
    });
  }
  if (/^\/realtime\/app-server\/[^/]+$/.test(subpath) && method === "DELETE" && ok) {
    await registry.update(deviceId, (record) => {
      delete record.liveSessionId;
      record.connectionState = "closed";
      record.codexState = "idle";
      record.codexActiveTasks = 0;
      record.codexQueueDepth = 0;
      record.pendingConfirmations = [];
    });
  }
}

function enforceServerOwnedDeviceSettings(
  record: DeviceRecord,
  subpath: string,
  method: string,
  bodyText: string | undefined,
): string | undefined {
  if (subpath !== "/realtime/app-server" || method !== "POST" || bodyText === undefined) {
    return bodyText;
  }
  const payload = parseJsonText(bodyText);
  if (!isRecord(payload)) return bodyText;
  const requestedSession = isRecord(payload["session"]) ? payload["session"] : {};
  return JSON.stringify({
    ...payload,
    session: {
      ...requestedSession,
      voice: normalizeVoice(record.voice) ?? "vale",
    },
  });
}

async function monitorBridgeEvents(
  stream: ReadableStream<Uint8Array>,
  deviceId: string,
  registry: DeviceRegistry,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            await registry.observeBridgeEvent(deviceId, JSON.parse(line));
          } catch {
            // Monitoring must never interrupt the device's native event stream.
          }
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

async function internalAuthRequest(
  auth: ChatGPTHandler,
  record: DeviceRecord,
  sourceRequest: Request,
  input: {
    path: string;
    method: string;
    body?: string;
    contentType?: string;
    accept?: string;
  },
): Promise<Response> {
  const target = new URL(`${auth.basePath}${input.path}`, sourceRequest.url);
  const headers = new Headers();
  if (record.lwcCookie) headers.set("cookie", record.lwcCookie);
  if (input.contentType) headers.set("content-type", input.contentType);
  if (input.accept) headers.set("accept", input.accept);
  return auth.handler(new Request(target, {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
  }));
}

async function authenticateDeviceRequest(
  registry: DeviceRegistry,
  deviceId: string,
  request: Request,
): Promise<DeviceRecord> {
  const token = readBearer(request);
  if (!token) throw new Error("Device bearer token is missing.");
  return registry.authenticateDevice(decodeURIComponent(deviceId), token);
}

async function authenticatePairingRequest(registry: DeviceRegistry, request: Request): Promise<DeviceRecord> {
  return registry.authenticateClaim(readCookie(request, PAIRING_COOKIE));
}

function isAllowedDeviceRoute(path: string, method: string): boolean {
  if (path === "/login") return method === "POST";
  if (path === "/status" || path === "/session" || path === "/models") return method === "GET";
  if (path === "/realtime") return method === "POST";
  if (path === "/realtime/app-server") return method === "POST";
  if (/^\/realtime\/app-server\/[^/]+\/events$/.test(path)) return method === "GET";
  if (/^\/realtime\/app-server\/[^/]+\/clock$/.test(path)) return method === "POST";
  if (/^\/realtime\/app-server\/[^/]+$/.test(path)) return method === "DELETE";
  return false;
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const bytes = await readBoundedBody(request);
  if (bytes instanceof Response) return bytes;
  const payload = parseJsonBytes(bytes ?? new Uint8Array());
  return isRecord(payload)
    ? payload
    : json({ error: "invalid_json_body" }, { status: 400 });
}

async function readBoundedBody(request: Request): Promise<Uint8Array | undefined | Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_JSON_BODY_BYTES) {
    return json({ error: "request_too_large" }, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > MAX_JSON_BODY_BYTES
    ? json({ error: "request_too_large" }, { status: 413 })
    : bytes;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  return parseJsonText(new TextDecoder().decode(bytes));
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) return {};
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

async function cloneWithoutSetCookie(response: Response): Promise<Response> {
  const bytes = await response.arrayBuffer();
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  });
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("cache-control", "no-store");
  return headers;
}

function extractCookie(setCookie: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(setCookie);
  return match?.[1] || undefined;
}

function readBearer(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : undefined;
}

function validSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeVoice(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (CHATGPT_REALTIME_VOICES as readonly string[]).includes(normalized)
    ? normalized
    : undefined;
}

function normalizeWakePhrase(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0
    && normalized.length <= 40
    && /^[a-z][a-z -]*$/.test(normalized)
    ? normalized
    : undefined;
}

function resolvePublicBaseUrl(request: Request, configured?: string): string {
  const base = new URL(configured ?? new URL(request.url).origin);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("The public setup URL must use HTTPS unless it is loopback.");
  }
  return base.toString().replace(/\/+$/, "");
}

function isSecureRequest(request: Request, configuredPublicBaseUrl?: string): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
    || (configuredPublicBaseUrl !== undefined && new URL(configuredPublicBaseUrl).protocol === "https:");
}

function publicError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}
