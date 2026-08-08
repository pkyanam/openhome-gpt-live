import { routeRealtimeHandoff } from "./handoff-routing.ts";

export type VoiceDestination = "native" | "openai_search" | "codex";

const CLOCK_ONLY = [
  /\b(?:what(?:'s| is)|tell me)\s+(?:the\s+)?(?:exact\s+)?(?:date|day|time|timezone)\b/i,
  /\b(?:date|day|time|timezone)\s+(?:right\s+)?now\b/i,
];

const EXPLICIT_WEB = [
  /\b(?:search|browse)\s+(?:the\s+)?(?:web|internet|online)\b/i,
  /\b(?:web|internet)\s+search\b/i,
  /\blook\s+(?:it|this|that|[^.?!]{1,120})\s+up\b/i,
  /\bfind\s+(?:it|this|that|[^.?!]{1,120})\s+(?:online|on\s+the\s+web)\b/i,
];

const CURRENT_INFORMATION = [
  /\b(?:latest|breaking|recent|today(?:'s)?|right\s+now|currently)\b/i,
  /\b(?:news|weather|forecast|score|standings|schedule|stock|share\s+price|release\s+tag)\b/i,
];

/** Local actions win; otherwise current-information requests use OpenAI search. */
export function routeVoiceRequest(transcript: string): VoiceDestination {
  if (routeRealtimeHandoff(transcript) === "codex") return "codex";
  if (CLOCK_ONLY.some((pattern) => pattern.test(transcript))) return "native";
  if ([...EXPLICIT_WEB, ...CURRENT_INFORMATION].some((pattern) => pattern.test(transcript))) {
    return "openai_search";
  }
  return "native";
}
