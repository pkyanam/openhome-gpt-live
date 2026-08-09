import { routeRealtimeHandoff } from "./handoff-routing.ts";

export type VoiceDestination = "native" | "openai_search" | "spotify" | "codex";

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
  /\b(?:price|prices|pricing|quote|market\s+price|market\s+cap|exchange\s+rate)\b/i,
];

/** Local actions win; otherwise current-information requests use OpenAI search. */
export function routeVoiceRequest(transcript: string, spotifyConfigured = false): VoiceDestination {
  if (spotifyConfigured && isSpotifyAbilityRequest(transcript)) return "spotify";
  if (routeRealtimeHandoff(transcript) === "codex") return "codex";
  if (CLOCK_ONLY.some((pattern) => pattern.test(transcript))) return "native";
  if ([...EXPLICIT_WEB, ...CURRENT_INFORMATION].some((pattern) => pattern.test(transcript))) {
    return "openai_search";
  }
  return "native";
}

/** Routine, deterministic playback requests accepted by the sister Ability. */
export function isSpotifyAbilityRequest(transcript: string): boolean {
  const text = transcript
    .replace(/^\s*[a-z][a-z0-9 -]{0,30}\s*[,;]\s*/i, "")
    .replace(/^\s*(?:please|can you|could you|would you)\s+/i, "")
    .trim();
  if (/\b(?:youtube|apple music|soundcloud|browser|video)\b/i.test(text)) return false;
  if (/\bsearch(?: spotify)?\b[\s\S]*\band\s+(?:play|queue|pick|choose)\b/i.test(text)) return false;
  if (/\b(?:what is|explain|tell me about)\s+spotify\b/i.test(text)) return false;
  if (/^(?:play|listen to)\s+\S/i.test(text)) {
    return !/\b(?:game|chess|poker|checkers|sports?|a role|devil'?s advocate)\b/i.test(text);
  }
  return [
    /^(?:pause|stop|resume|continue|unpause)(?: spotify| the (?:music|song|track|podcast))?[?.!]*$/i,
    /^(?:next|skip|previous|back|go back)(?: song| track| item| episode)?[?.!]*$/i,
    /^(?:queue|add)\s+\S/i,
    /^(?:search(?: spotify)? for|find(?: on spotify)?)\s+\S/i,
    /\b(?:what(?:'s| is) playing|now playing|current (?:song|track|playback)|spotify status)\b/i,
    /^(?:mute|silence|maximum volume|max volume|full volume|volume up|volume down|turn (?:spotify|the music) (?:up|down))/i,
    /^(?:set )?(?:spotify )?volume(?: to)?\s+\d/i,
    /^(?:turn|change) (?:spotify|the music|the volume) (?:up|down)/i,
    /^(?:seek|skip|go) to\s+\S/i,
    /^(?:(?:skip|jump|seek|go)\s+(?:forward|back(?:ward)?|ahead)|rewind)\s+\S/i,
    /^(?:use|select|switch to)\s+.+\s+(?:for spotify|as (?:the )?spotify device)[?.!]*$/i,
  ].some((pattern) => pattern.test(text));
}
