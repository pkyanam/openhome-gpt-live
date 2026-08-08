import { describe, expect, test } from "bun:test";
import { OpenHomeClient } from "./openhome-client.ts";
import { createOpenHomeToolPolicy } from "./openhome-tools.ts";

describe("OpenHome tool policy", () => {
  test("does not toggle an Ability before explicit confirmation", async () => {
    let mutationCount = 0;
    const fakeFetch = (async () => {
      mutationCount += 1;
      return Response.json({ enabled: true });
    }) as unknown as typeof fetch;
    const policy = createOpenHomeToolPolicy(new OpenHomeClient({ apiKey: "test", fetch: fakeFetch }));
    const request = new Request("https://app.test/api/chatgpt/realtime/app-server");
    const context = {
      callId: "call-1",
      name: "openhome_prepare_ability_toggle",
      arguments: {
        installedCapabilityId: 42,
        enabled: true,
        triggerWords: ["lights"],
      },
      loginSessionId: "login-1",
      liveSessionId: "live-1",
      request,
    };

    const pending = await policy.executeTool(context);
    expect(mutationCount).toBe(0);
    expect(pending.pendingConfirmation?.review).toEqual({
      title: "Enable OpenHome Ability",
      installedCapabilityId: 42,
      enabled: true,
      triggerWords: ["lights"],
    });

    const cancelled = await policy.confirmTool({ ...context, confirmation: { approved: false }, pending });
    expect(cancelled.output).toEqual({ status: "cancelled", operation: "openhome.toggle_ability.v1" });
    expect(mutationCount).toBe(0);

    const completed = await policy.confirmTool({ ...context, confirmation: { approved: true }, pending });
    expect(completed.output).toEqual({
      status: "completed",
      operation: "openhome.toggle_ability.v1",
      result: { enabled: true },
    });
    expect(mutationCount).toBe(1);
  });

  test("rejects malformed tool arguments even after schema selection", async () => {
    const policy = createOpenHomeToolPolicy(new OpenHomeClient({ apiKey: "test" }));
    await expect(policy.executeTool({
      callId: "call-1",
      name: "openhome_prepare_ability_toggle",
      arguments: { installedCapabilityId: 0, enabled: true, triggerWords: [] },
      loginSessionId: "login-1",
      liveSessionId: "live-1",
      request: new Request("https://app.test"),
    })).rejects.toThrow("positive integer");
  });
});
