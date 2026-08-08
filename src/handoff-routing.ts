export type HandoffDestination = "codex" | "native";

const SIMPLE_CURRENT_INFO = [
  /\bsearch(?: the)? (?:web|internet|online)\b/i,
  /\b(?:web|internet|online) search\b/i,
  /\blook up\b/i,
  /\b(?:latest|today(?:'s)?|current|recent) (?:news|headlines|weather|forecast|score|scores|price|prices|information|info|updates?)\b/i,
  /\b(?:news|headlines|weather|forecast) (?:today|now|about|for|on)\b/i,
];

const CODEX_SIDE_EFFECT = [
  /\b(?:save|write|create|build|make|edit|change|update|delete|remove|move|rename|download|install|run|execute|launch|control|send|email|post|publish|deploy)\b/i,
  /\b(?:open|close) (?:the |my )?(?:file|folder|directory|project|repository|repo|app|application|browser|safari|chrome|terminal|window)\b/i,
  /\b(?:file|folder|directory|workspace|project|repository|repo|mac|macbook|computer|desktop|downloads?)\b/i,
  /\b(?:openhome|speaker) (?:ability|setting|configuration|account|device)\b/i,
];

/**
 * Native GPT Live owns simple searches. A search with an explicit local or
 * external side effect remains a Codex task so the requested action can run.
 */
export function routeRealtimeHandoff(transcript: string): HandoffDestination {
  const isSimpleCurrentInfo = SIMPLE_CURRENT_INFO.some((pattern) => pattern.test(transcript));
  const hasCodexSideEffect = CODEX_SIDE_EFFECT.some((pattern) => pattern.test(transcript));
  return isSimpleCurrentInfo && !hasCodexSideEffect ? "native" : "codex";
}
