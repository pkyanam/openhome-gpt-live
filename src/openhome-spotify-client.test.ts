import { describe, expect, test } from "bun:test";
import { OpenHomeSpotifyClient } from "./openhome-spotify-client.ts";

describe("OpenHomeSpotifyClient", () => {
  test("requires both optional settings and rejects insecure remote HTTP", () => {
    expect(() => new OpenHomeSpotifyClient({ baseUrl: "http://127.0.0.1:3199" })).toThrow("configured together");
    expect(() => new OpenHomeSpotifyClient({
      baseUrl: "http://speaker.example:3199",
      token: "test-token",
    })).toThrow("HTTPS");
    expect(new OpenHomeSpotifyClient().configured).toBe(false);
  });

  test("submits once and polls only the accepted request", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; body?: unknown }> = [];
    const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.endsWith("/v1/voice/execute")) {
        return Response.json({ status: "accepted", events: [{ type: "spotify.acknowledgement" }] }, { status: 202 });
      }
      return Response.json({
        status: "completed",
        tool: "spotify.play",
        events: [{ type: "spotify.completion", message: "Dreams by Fleetwood Mac is playing." }],
      });
    };
    const client = new OpenHomeSpotifyClient({
      baseUrl: "http://127.0.0.1:3199",
      token: "tool-token",
      fetch: fetcher,
      pollIntervalMs: 0,
    });

    await expect(client.executeVoice("play Dreams by Fleetwood Mac", "spotify-request-1"))
      .resolves.toEqual({
        speech: "Dreams by Fleetwood Mac is playing.",
        speakCompletion: false,
        tool: "spotify.play",
      });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "POST",
      authorization: "Bearer tool-token",
      body: {
        transcript: "play Dreams by Fleetwood Mac",
        requestId: "spotify-request-1",
        ownerId: "openhome-gpt-live",
      },
    });
    expect(calls[1]!.url).toEndWith("/v1/requests/spotify-request-1");
  });

  test("does not retry an ambiguous submit failure", async () => {
    let calls = 0;
    const client = new OpenHomeSpotifyClient({
      baseUrl: "http://127.0.0.1:3199",
      token: "tool-token",
      fetch: async () => {
        calls += 1;
        throw new TypeError("connection reset");
      },
    });
    await expect(client.executeVoice("next", "spotify-request-2")).rejects.toThrow("connection reset");
    expect(calls).toBe(1);
  });
});
