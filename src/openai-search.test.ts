import { describe, expect, test } from "bun:test";
import { parseOpenAISearchEvents } from "./openai-search.ts";

describe("OpenAI subscription web search", () => {
  test("requires a real search call and returns speech-friendly text", () => {
    const events = [
      'data: {"type":"response.output_text.done","text":"Latest is **v1**. ([GitHub](https://github.com/example))"}',
      'data: {"type":"response.completed","response":{"tool_usage":{"web_search":{"num_requests":1}}}}',
    ].join("\n");
    expect(parseOpenAISearchEvents(events)).toBe("Latest is v1. (GitHub)");
    expect(() => parseOpenAISearchEvents(
      'data: {"type":"response.output_text.done","text":"I guessed."}',
    )).toThrow("without running web search");
  });
});
