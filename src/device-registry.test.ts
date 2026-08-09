import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceRegistry, pairingCookieValue, type DeviceRecord } from "./device-registry.ts";
import { JsonFileStore } from "./file-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DeviceRegistry", () => {
  test("registers, resumes, pairs, and authenticates without storing raw secrets", async () => {
    const { registry, store } = await createRegistry();
    const registration = await registry.register(
      " Kitchen DevKit ",
      undefined,
      "vale",
      "juniper",
    );
    expect(registration.record.name).toBe("Kitchen DevKit");
    expect(registration.record.voice).toBe("vale");
    expect(registration.record.wakePhrase).toBe("juniper");
    expect(registration.pairingCode).toMatch(/^\d{8}$/);

    const stored = await store.get(registration.record.id);
    expect(stored?.deviceTokenHash).not.toContain(registration.deviceToken);
    expect(stored?.pairingCodeHash).not.toBe(registration.pairingCode);

    const claim = await registry.claim(registration.pairingCode!);
    const cookie = pairingCookieValue(claim.record.id, claim.claimToken);
    expect((await registry.authenticateClaim(cookie)).id).toBe(registration.record.id);
    await expect(registry.claim(registration.pairingCode!)).rejects.toThrow("invalid or expired");

    const secondCode = await registry.issuePairing(registration.record.id);
    const secondClaim = await registry.claim(secondCode);
    const secondCookie = pairingCookieValue(secondClaim.record.id, secondClaim.claimToken);
    expect((await registry.authenticateClaim(cookie)).id).toBe(registration.record.id);
    expect((await registry.authenticateClaim(secondCookie)).id).toBe(registration.record.id);

    const resumed = await registry.register("ignored", {
      deviceId: registration.record.id,
      deviceToken: registration.deviceToken,
    }, "juniper", "maple");
    expect(resumed.record.id).toBe(registration.record.id);
    expect(resumed.pairingCode).toBeUndefined();
    expect(resumed.record.voice).toBe("vale");
    expect(resumed.record.wakePhrase).toBe("juniper");
  });

  test("serializes simultaneous record updates", async () => {
    const { registry } = await createRegistry();
    const registration = await registry.register("DevKit");
    await Promise.all([
      registry.update(registration.record.id, (record) => { record.connectionState = "live"; }),
      registry.update(registration.record.id, (record) => { record.selectedModel = "gpt-live-test"; }),
      registry.observeBridgeEvent(registration.record.id, {
        type: "tool.pending_confirmation",
        callId: "call-1",
        name: "openhome_prepare_ability_toggle",
        review: { enabled: true },
      }),
    ]);

    const record = await registry.get(registration.record.id);
    expect(record?.connectionState).toBe("live");
    expect(record?.selectedModel).toBe("gpt-live-test");
    expect(record?.pendingConfirmations).toHaveLength(1);
  });

  test("tracks Codex work and queue state without persisting voice transcripts", async () => {
    const { registry, store } = await createRegistry();
    const registration = await registry.register("DevKit");
    await registry.observeBridgeEvent(registration.record.id, { type: "session.started" });
    await registry.observeBridgeEvent(registration.record.id, {
      type: "handoff.started",
      taskId: "task-1",
      transcript: "private spoken request",
      queued: false,
    });
    await registry.observeBridgeEvent(registration.record.id, {
      type: "handoff.queued",
      taskId: "task-2",
      transcript: "another private request",
      position: 1,
    });
    await registry.observeBridgeEvent(registration.record.id, {
      type: "handoff.completed",
      taskId: "task-1",
      transcript: "private spoken request",
      status: "completed",
      fallbackSpeech: true,
    });
    await registry.observeBridgeEvent(registration.record.id, {
      type: "handoff.started",
      taskId: "task-2",
      transcript: "another private request",
      queued: true,
    });
    await registry.observeBridgeEvent(registration.record.id, {
      type: "handoff.redirected",
      transcript: "private native search",
      destination: "native",
    });
    await registry.observeBridgeEvent(registration.record.id, {
      type: "search.started",
      taskId: "search-1",
      transcript: "private search request",
    });

    const record = await store.get(registration.record.id);
    expect(record).toMatchObject({
      codexState: "working",
      codexQueueDepth: 0,
      lastCodexTaskStatus: "completed",
      lastVoiceRoute: "openai_search",
    });
    expect(JSON.stringify(record)).not.toContain("private spoken request");
    expect(JSON.stringify(record)).not.toContain("private native search");
    expect(JSON.stringify(record)).not.toContain("private search request");
  });
});

async function createRegistry(): Promise<{
  registry: DeviceRegistry;
  store: JsonFileStore<DeviceRecord>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "openhome-gpt-registry-"));
  temporaryDirectories.push(directory);
  const store = new JsonFileStore<DeviceRecord>(join(directory, "devices.json"));
  return { registry: new DeviceRegistry(store, "s".repeat(64)), store };
}
