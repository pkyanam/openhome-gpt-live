import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatGPTHandler } from "@opencoredev/loginwithchatgpt-server";
import { DeviceRegistry, type DeviceRecord } from "./device-registry.ts";
import { createDeviceRoutes, keepAliveNdjson } from "./device-routes.ts";
import { JsonFileStore } from "./file-store.ts";
import { PairingCodeStore, type PairingCodeRecord } from "./pairing-code-store.ts";

const BOOTSTRAP_TOKEN = "b".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("headless DevKit routes", () => {
  test("keeps a quiet realtime event stream open", async () => {
    const upstream = new ReadableStream<Uint8Array>({ start() {} });
    const reader = keepAliveNdjson(upstream, 5).getReader();
    const event = await reader.read();

    expect(event.done).toBeFalse();
    expect(new TextDecoder().decode(event.value)).toBe("\n");
    await reader.cancel();
  });

  test("pairs a phone while keeping ChatGPT and device credentials server-side", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openhome-gpt-routes-"));
    temporaryDirectories.push(directory);
    const registry = new DeviceRegistry(
      new JsonFileStore<DeviceRecord>(join(directory, "devices.json")),
      "s".repeat(64),
    );
    const internalRequests: Request[] = [];
    let confirmationBody: unknown;
    const auth = fakeAuth(internalRequests, (value) => { confirmationBody = value; });
    const pairingCodes = new PairingCodeStore(
      new JsonFileStore<PairingCodeRecord>(join(directory, "pairing-codes.json")),
    );
    const route = createDeviceRoutes({
      auth,
      registry,
      bootstrapToken: BOOTSTRAP_TOKEN,
      publicBaseUrl: "https://voice.example.test",
      pairingCodes,
    });

    const denied = await route(jsonRequest("https://service.test/api/device/register", {
      method: "POST",
      body: { name: "DevKit" },
    }));
    expect(denied.status).toBe(401);

    const registrationResponse = await route(jsonRequest("https://service.test/api/device/register", {
      method: "POST",
      bearer: BOOTSTRAP_TOKEN,
      body: { name: "Living Room DevKit" },
    }));
    expect(registrationResponse.status).toBe(200);
    const registration = await registrationResponse.json() as {
      deviceId: string;
      deviceToken: string;
      pairingCode: string;
      setupUrl: string;
    };
    expect(registration.setupUrl).toBe("https://voice.example.test/setup");
    expect((await pairingCodes.latest())?.code).toBe(registration.pairingCode);

    const settingsBefore = await route(new Request(
      `https://service.test/api/device/${registration.deviceId}/settings`,
      { headers: { authorization: `Bearer ${registration.deviceToken}` } },
    ));
    expect(await settingsBefore.json()).toEqual({ voice: "vale" });

    const deviceBase = `https://service.test/api/device/${registration.deviceId}/chatgpt`;
    const loginResponse = await route(new Request(`${deviceBase}/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${registration.deviceToken}` },
    }));
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.has("set-cookie")).toBeFalse();
    expect(await loginResponse.json()).toMatchObject({ status: "pending", userCode: "ABCD-EFGH" });

    const claimResponse = await route(jsonRequest("https://service.test/api/pairing/claim", {
      method: "POST",
      body: { code: registration.pairingCode },
    }));
    expect(claimResponse.status).toBe(200);
    const pairingCookie = claimResponse.headers.get("set-cookie")!.split(";")[0]!;
    expect(pairingCookie).toStartWith("ohgpt_pairing=");
    expect(claimResponse.headers.get("set-cookie")).toContain("Secure");
    expect(await pairingCodes.latest()).toBeUndefined();

    const sessionResponse = await route(new Request(`${deviceBase}/session`, {
      headers: { authorization: `Bearer ${registration.deviceToken}` },
    }));
    expect(await sessionResponse.json()).toMatchObject({
      status: "authenticated",
      user: { email: "owner@example.test" },
    });

    const startResponse = await route(jsonRequest(`${deviceBase}/realtime/app-server`, {
      method: "POST",
      bearer: registration.deviceToken,
      body: { sdp: "v=0\r\n", session: { model: "gpt-live-test", voice: "juniper" } },
    }));
    expect(startResponse.status).toBe(201);
    expect(await startResponse.json()).toEqual({ sessionId: "live-1", sdp: "v=0\r\nanswer" });

    const eventsResponse = await route(new Request(`${deviceBase}/realtime/app-server/live-1/events`, {
      headers: { authorization: `Bearer ${registration.deviceToken}` },
    }));
    expect(eventsResponse.status).toBe(200);
    expect(await eventsResponse.text()).toContain("tool.pending_confirmation");
    await Bun.sleep(10);

    const pairedSessionResponse = await route(new Request("https://service.test/api/pairing/session", {
      headers: { cookie: pairingCookie },
    }));
    const paired = await pairedSessionResponse.json() as { session: { pendingConfirmations: unknown[] } };
    expect(paired.session.pendingConfirmations).toHaveLength(1);

    const confirmResponse = await route(jsonRequest("https://service.test/api/pairing/confirm", {
      method: "POST",
      cookie: pairingCookie,
      body: { callId: "call-1", approved: true },
    }));
    expect(confirmResponse.status).toBe(200);
    expect(confirmationBody).toEqual({ callId: "call-1", confirmation: { approved: true } });

    const pairedAfter = await route(new Request("https://service.test/api/pairing/session", {
      headers: { cookie: pairingCookie },
    }));
    expect((await pairedAfter.json() as { session: { pendingConfirmations: unknown[] } }).session.pendingConfirmations).toEqual([]);

    await registry.update(registration.deviceId, (record) => { record.codexState = "working"; });
    const busyVoiceResponse = await route(jsonRequest("https://service.test/api/pairing/voice", {
      method: "POST",
      cookie: pairingCookie,
      body: { voice: "vale" },
    }));
    expect(busyVoiceResponse.status).toBe(409);
    await registry.update(registration.deviceId, (record) => { record.codexState = "idle"; });

    const voiceResponse = await route(jsonRequest("https://service.test/api/pairing/voice", {
      method: "POST",
      cookie: pairingCookie,
      body: { voice: "vale" },
    }));
    expect(voiceResponse.status).toBe(200);
    expect(await voiceResponse.json()).toMatchObject({
      reconnecting: true,
      session: { voice: "vale", connectionState: "reconnecting" },
    });
    expect(internalRequests.some((request) =>
      request.method === "DELETE"
      && new URL(request.url).pathname.endsWith("/realtime/app-server/live-1")
    )).toBeTrue();

    const invalidVoice = await route(jsonRequest("https://service.test/api/pairing/voice", {
      method: "POST",
      cookie: pairingCookie,
      body: { voice: "made-up" },
    }));
    expect(invalidVoice.status).toBe(400);
    expect(internalRequests.every((request) => !request.headers.has("authorization"))).toBeTrue();
    expect(internalRequests.slice(1).every((request) => request.headers.get("cookie") === "lwc_session=opaque-login-cookie")).toBeTrue();
  });
});

function fakeAuth(
  requests: Request[],
  setConfirmation: (value: unknown) => void,
): ChatGPTHandler {
  const handler = async (request: Request): Promise<Response> => {
    requests.push(request.clone());
    const path = new URL(request.url).pathname.replace(/^\/api\/chatgpt/, "");
    if (path === "/login") {
      return Response.json(
        {
          status: "pending",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://chatgpt.com/activate",
          interval: 5,
        },
        { headers: { "set-cookie": "lwc_session=opaque-login-cookie; HttpOnly; Path=/" } },
      );
    }
    if (path === "/session") {
      return Response.json({
        status: "authenticated",
        user: { email: "owner@example.test", name: "Owner", plan: "plus" },
      });
    }
    if (path === "/models") return Response.json({ models: ["gpt-live-test"] });
    if (path === "/realtime/app-server" && request.method === "POST") {
      return Response.json({ sessionId: "live-1", sdp: "v=0\r\nanswer" }, { status: 201 });
    }
    if (path === "/realtime/app-server/live-1/events") {
      const event = {
        type: "tool.pending_confirmation",
        callId: "call-1",
        name: "openhome_prepare_ability_toggle",
        review: { enabled: true },
      };
      return new Response(`${JSON.stringify(event)}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    if (path === "/realtime/app-server/live-1/confirm") {
      setConfirmation(await request.json());
      return Response.json({ status: "resolved", callId: "call-1" });
    }
    if (path === "/realtime/app-server/live-1" && request.method === "DELETE") {
      return Response.json({ status: "closed" });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  return {
    basePath: "/api/chatgpt",
    handler,
    fetch: handler,
    proxyFetch: () => fetch,
    getSession: async () => ({
      status: "authenticated",
      user: { email: "owner@example.test", accountId: "account-1" },
    }),
    getTokens: async () => undefined,
    dangerouslyGetTokens: async () => undefined,
    getModels: async () => ["gpt-live-test"],
  };
}

function jsonRequest(
  url: string,
  options: {
    method?: string;
    bearer?: string;
    cookie?: string;
    body: unknown;
  },
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(url, {
    method: options.method ?? "POST",
    headers,
    body: JSON.stringify(options.body),
  });
}
