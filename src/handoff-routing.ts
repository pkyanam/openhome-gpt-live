export type HandoffDestination = "codex" | "native";
export type CodexTaskKind = "general" | "computer" | "media";

const NATIVE_ONLY = [
  /^\s*native-only retry\b/i,
  /\b(?:do not|don't|never)\s+(?:use|ask|send|delegate|hand(?: it)? off to)\s+codex\b/i,
];

const EXPLICIT_CODEX = [
  /\b(?:use|ask|tell|have|send|delegate|hand(?: it)? off to) codex\b/i,
  /\b(?:codex) (?:to|should|can you|please)\b/i,
];

const LOCAL_TARGET =
  "(?:file|folder|directory|workspace|project|repository|repo|codebase|game|website|web app|app|application|script|program|dashboard|document|spreadsheet|presentation)";
const LOCAL_ACTION =
  "(?:inspect|list|read|save|write|create|build|make|edit|change|update|delete|remove|move|rename|download|install|run|execute|test|fix|debug|refactor|commit|push|publish|deploy)";

const MEDIA_TARGET =
  "(?:song|track|music|album|playlist|podcast|audiobook|video|trailer|movie|show|youtube|spotify|apple music|music app|soundcloud)";
const MEDIA_ACTION =
  "(?:play|stream|listen to|watch|put on|pause|resume|stop|skip|next|previous|queue|shuffle|repeat|control|open|launch|close|quit|mute|unmute|turn up|turn down)";
const NON_MEDIA_PLAY_TARGET =
  /\b(?:chess|poker|checkers|game|games|sport|sports|football|basketball|baseball|tennis|devil'?s advocate|a role)\b/i;

const CODEX_ACTION = [
  new RegExp(`\\b${MEDIA_ACTION}\\b[\\s\\S]{0,120}\\b${MEDIA_TARGET}\\b`, "i"),
  new RegExp(`\\b${MEDIA_TARGET}\\b[\\s\\S]{0,120}\\b${MEDIA_ACTION}\\b`, "i"),
  new RegExp(`\\b${LOCAL_ACTION}\\b[\\s\\S]{0,100}\\b${LOCAL_TARGET}\\b`, "i"),
  new RegExp(`\\b${LOCAL_TARGET}\\b[\\s\\S]{0,80}\\b(?:on|in|inside|under|within) (?:my |the )?(?:mac|macbook|computer|desktop|workspace|repository|repo)\\b`, "i"),
  /\b(?:what|which|show|tell me) (?:files|folders|directories|projects)\b[\s\S]{0,80}\b(?:workspace|repo|repository|computer|mac|macbook)\b/i,
  /\b(?:open|close|launch|quit|control|click|type|press|scroll)\b[\s\S]{0,100}\b(?:file|folder|directory|project|repo|app|application|browser|safari|chrome|terminal|window|mac|macbook|computer|desktop)\b/i,
  /\b(?:openhome|open home|speaker)\b[\s\S]{0,80}\b(?:abilit(?:y|ies)|settings?|configurations?|accounts?|devices?)\b/i,
  /\b(?:abilit(?:y|ies)|settings?|configurations?|accounts?|devices?)\b[\s\S]{0,80}\b(?:openhome|open home|speaker)\b/i,
  /\b(?:send|email|post|publish|purchase|buy|order|book|schedule)\b[\s\S]{0,100}\b(?:email|message|post|comment|item|appointment|meeting|reservation|ticket)\b/i,
  /\b(?:open|navigate to|go to)\b[\s\S]{0,80}\b(?:website|web page|url|browser|safari|chrome)\b/i,
  /\bplay\b[\s\S]{0,100}\b(?:game|chess|poker|checkers)\b[\s\S]{0,100}\b(?:browser|safari|chrome|mac|macbook|computer)\b/i,
];

const EXPLANATION_ONLY = [
  /\b(?:how|why|what) (?:do|does|is|are|would|could|should)\b/i,
  /\b(?:explain|describe|teach me|tell me about|give me an example)\b/i,
];

/**
 * This first pass separates local/action work from native requests. A second
 * voice-router pass can send current-information requests to OpenAI search.
 * Defaulting to native ensures an ordinary request cannot become a Mac task
 * merely because Live requested a delegation.
 */
export function routeRealtimeHandoff(transcript: string): HandoffDestination {
  if (NATIVE_ONLY.some((pattern) => pattern.test(transcript))) return "native";
  if (EXPLICIT_CODEX.some((pattern) => pattern.test(transcript))) return "codex";
  if (isMediaControlRequest(transcript)) return "codex";
  if (EXPLANATION_ONLY.some((pattern) => pattern.test(transcript))) return "native";
  return CODEX_ACTION.some((pattern) => pattern.test(transcript)) ? "codex" : "native";
}

/** True only for an imperative media or media-application control request. */
export function isMediaControlRequest(transcript: string): boolean {
  const normalized = transcript.replace(/^\s*[a-z][a-z0-9 -]{0,30}\s*[,;:]\s*/i, "").trim();
  const explicitTarget = new RegExp(`\\b${MEDIA_TARGET}\\b`, "i").test(normalized);
  const explicitAction = new RegExp(`\\b${MEDIA_ACTION}\\b`, "i").test(normalized);
  if (explicitTarget && explicitAction) return true;
  return /^\s*(?:please\s+)?play\b/i.test(normalized) && !NON_MEDIA_PLAY_TARGET.test(normalized);
}

/** Classifies an accepted Codex request for its execution contract and limits. */
export function classifyCodexTask(transcript: string): CodexTaskKind {
  if (isMediaControlRequest(transcript)) return "media";
  if (/\b(?:browser|tab|window|helium|chrome|safari|spotify|youtube|terminal|mac|macbook|computer|desktop)\b/i.test(transcript)
      && /\b(?:open|close|launch|quit|control|click|type|press|scroll|select|play)\b/i.test(transcript)) {
    return "computer";
  }
  return "general";
}
