import { describe, expect, test } from "bun:test";
import { routeVoiceRequest } from "./voice-routing.ts";

describe("speaker voice routing", () => {
  test("uses the first-party OpenAI search lane for current information", () => {
    expect(routeVoiceRequest("search the web for today's OpenHome news")).toBe("openai_search");
    expect(routeVoiceRequest("look up the latest release tag")).toBe("openai_search");
    expect(routeVoiceRequest("what is the weather in Scranton right now")).toBe("openai_search");
  });

  test("keeps local mutations in Codex even when research is involved", () => {
    expect(routeVoiceRequest("search the web and save the results in my workspace")).toBe("codex");
    expect(routeVoiceRequest("use Codex to create a game on my Mac")).toBe("codex");
  });

  test("keeps conversation and clock questions in GPT Live", () => {
    expect(routeVoiceRequest("explain photosynthesis in five sentences")).toBe("native");
    expect(routeVoiceRequest("what is the exact date and time right now")).toBe("native");
  });
});
