import { describe, expect, test } from "bun:test";
import { classifyCodexTask, routeRealtimeHandoff } from "./handoff-routing.ts";

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
    expect(routeRealtimeHandoff("Juniper, explain photosynthesis in five sentences"))
      .toBe("native");
    expect(routeRealtimeHandoff("Juniper, what time is it?"))
      .toBe("native");
    expect(routeRealtimeHandoff("How do I create a file in a Python program?"))
      .toBe("native");
    expect(routeRealtimeHandoff("Native-only retry. Do not delegate to Codex: search the web for OpenHome news"))
      .toBe("native");
    expect(routeRealtimeHandoff("Don't use Codex; search the web for OpenHome news"))
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
    expect(routeRealtimeHandoff("List the directories in my workspace"))
      .toBe("codex");
    expect(routeRealtimeHandoff("Use Codex to calculate two plus two"))
      .toBe("codex");
    expect(routeRealtimeHandoff("Send an email message to my teammate"))
      .toBe("codex");
    expect(routeRealtimeHandoff("Tell me which abilities are installed on OpenHome"))
      .toBe("codex");
  });

  test("routes media playback and application controls to Codex", () => {
    expect(routeRealtimeHandoff("Lara, play Midnight City on YouTube")).toBe("codex");
    expect(routeRealtimeHandoff("play Midnight City")).toBe("codex");
    expect(routeRealtimeHandoff("control Spotify and play my discover weekly playlist")).toBe("codex");
    expect(routeRealtimeHandoff("pause Spotify")).toBe("codex");
    expect(routeRealtimeHandoff("skip this song in Apple Music")).toBe("codex");
    expect(routeRealtimeHandoff("play chess in Chrome")).toBe("codex");
    expect(routeRealtimeHandoff("what is Spotify")).toBe("native");
    expect(routeRealtimeHandoff("explain how to play chess")).toBe("native");
    expect(classifyCodexTask("play Midnight City on YouTube")).toBe("media");
    expect(classifyCodexTask("control Spotify")).toBe("media");
    expect(classifyCodexTask("play chess in Chrome")).toBe("computer");
    expect(classifyCodexTask("create a game in my workspace")).toBe("general");
  });
});
