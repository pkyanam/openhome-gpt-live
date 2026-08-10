import { describe, expect, test } from "bun:test";
import { routeVoiceRequest } from "./voice-routing.ts";

describe("speaker voice routing", () => {
  test("uses the first-party OpenAI search lane for current information", () => {
    expect(routeVoiceRequest("search the web for today's OpenHome news")).toBe("openai_search");
    expect(routeVoiceRequest("look up the latest release tag")).toBe("openai_search");
    expect(routeVoiceRequest("what is the weather in Scranton right now")).toBe("openai_search");
    expect(routeVoiceRequest("what is the Bitcoin price")).toBe("openai_search");
    expect(routeVoiceRequest("look up Bitcoin pricing")).toBe("openai_search");
  });

  test("keeps local mutations in Codex even when research is involved", () => {
    expect(routeVoiceRequest("search the web and save the results in my workspace")).toBe("codex");
    expect(routeVoiceRequest("use Codex to create a game on my Mac")).toBe("codex");
    expect(routeVoiceRequest("play a song on YouTube")).toBe("codex");
    expect(routeVoiceRequest("control Spotify")).toBe("codex");
    expect(routeVoiceRequest("search Spotify and play the first matching song")).toBe("codex");
    expect(routeVoiceRequest("play today's top hits on Spotify")).toBe("codex");
  });

  test("uses Spotify only when the separate Ability is configured", () => {
    expect(routeVoiceRequest("Lara, play Dreams by Fleetwood Mac", true)).toBe("spotify");
    expect(routeVoiceRequest("pause", true)).toBe("spotify");
    expect(routeVoiceRequest("queue Go Your Own Way", true)).toBe("spotify");
    expect(routeVoiceRequest("set Spotify volume to 20 percent", true)).toBe("spotify");
    expect(routeVoiceRequest("what's playing", true)).toBe("spotify");
    expect(routeVoiceRequest("open the Spotify app and play Dreams by Fleetwood Mac", true)).toBe("spotify");
    expect(routeVoiceRequest("use Spotify to play Dreams by Fleetwood Mac", true)).toBe("spotify");
    expect(routeVoiceRequest("I want you to put on Dreams by Fleetwood Mac", true)).toBe("spotify");
    expect(routeVoiceRequest("control Spotify", true)).toBe("spotify");
    expect(routeVoiceRequest("open Spotify", true)).toBe("spotify");
    expect(routeVoiceRequest("search Spotify and play the first matching song", true)).toBe("spotify");
    expect(routeVoiceRequest("play today's top hits on Spotify", true)).toBe("spotify");
    expect(routeVoiceRequest("play a song on YouTube", true)).toBe("codex");
    expect(routeVoiceRequest("play Dreams in the Spotify app on my Mac", true)).toBe("codex");
    expect(routeVoiceRequest("open Spotify in the browser on my computer", true)).toBe("codex");
    expect(routeVoiceRequest("play Dreams by Fleetwood Mac")).toBe("codex");
  });

  test("keeps conversation and clock questions in GPT Live", () => {
    expect(routeVoiceRequest("explain photosynthesis in five sentences")).toBe("native");
    expect(routeVoiceRequest("what is the exact date and time right now")).toBe("native");
    expect(routeVoiceRequest("what is Spotify")).toBe("native");
  });
});
