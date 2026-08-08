import { describe, expect, test } from "bun:test";
import { OpenHomeClient } from "./openhome-client.ts";

describe("OpenHomeClient", () => {
  test("lists installed abilities with a server-only API key", async () => {
    let observed: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observed = new Request(input, init);
      return Response.json({ abilities: [{ id: 1 }] });
    }) as typeof fetch;
    const client = new OpenHomeClient({
      apiKey: "test-key",
      baseUrl: "https://openhome.test",
      fetch: fakeFetch,
    });

    await expect(client.listAbilities("installed")).resolves.toEqual({ abilities: [{ id: 1 }] });
    expect(observed?.url).toBe("https://openhome.test/api/capabilities/get-installed-capabilities/");
    expect(observed?.headers.get("x-api-key")).toBe("test-key");
  });

  test("sends the documented toggle payload", async () => {
    let body = "";
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      body = await request.text();
      return Response.json({ ok: true });
    }) as typeof fetch;
    const client = new OpenHomeClient({ apiKey: "test-key", fetch: fakeFetch });

    await client.toggleAbility({
      installedCapabilityId: 456,
      enabled: true,
      triggerWords: ["weather", "forecast"],
    });

    expect(JSON.parse(body)).toEqual({ enabled: true, trigger_words: ["weather", "forecast"] });
  });

  test("fails closed when the API key is absent", async () => {
    const client = new OpenHomeClient({ apiKey: "" });
    await expect(client.listAgents()).rejects.toThrow("OPENHOME_API_KEY");
  });
});
