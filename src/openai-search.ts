/** Parse a streamed ChatGPT Responses result and require a real web-search call. */
export function parseOpenAISearchEvents(body: string): string {
  let result = "";
  let usedSearch = false;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event["type"] === "response.output_text.done" && typeof event["text"] === "string") {
      result = event["text"] as string;
    }
    if (event["type"] === "response.web_search_call.completed") usedSearch = true;
    if (event["type"] === "response.completed") {
      const response = isRecord(event["response"]) ? event["response"] : undefined;
      const usage = response && isRecord(response["tool_usage"]) ? response["tool_usage"] : undefined;
      const search = usage && isRecord(usage["web_search"]) ? usage["web_search"] : undefined;
      if (typeof search?.["num_requests"] === "number" && search["num_requests"] > 0) usedSearch = true;
    }
  }
  if (!usedSearch) throw new Error("OpenAI returned an answer without running web search.");
  if (!result.trim()) throw new Error("OpenAI web search completed without a spoken result.");
  return speechFriendlyText(result);
}

function speechFriendlyText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
