import { describe, expect, test } from "bun:test";
import { routeRealtimeHandoff } from "./handoff-routing.ts";

describe("realtime handoff routing", () => {
  test("keeps simple web and current-information requests in native GPT Live", () => {
    expect(routeRealtimeHandoff("Juniper, search the web for today's OpenHome news"))
      .toBe("native");
    expect(routeRealtimeHandoff("Look up the latest weather in New York"))
      .toBe("native");
    expect(routeRealtimeHandoff("What are today's news headlines about OpenHome?"))
      .toBe("native");
    expect(routeRealtimeHandoff("Juniper, search the web for today's Open Home news"))
      .toBe("native");
  });

  test("keeps searches with side effects in Codex", () => {
    expect(routeRealtimeHandoff("Search the web and save the results to a file"))
      .toBe("codex");
    expect(routeRealtimeHandoff("Look up OpenHome news and build me a dashboard"))
      .toBe("codex");
  });

  test("continues routing local build and Mac-control tasks to Codex", () => {
    expect(routeRealtimeHandoff("Create a game in my workspace"))
      .toBe("codex");
    expect(routeRealtimeHandoff("Open Safari on my MacBook"))
      .toBe("codex");
  });
});
