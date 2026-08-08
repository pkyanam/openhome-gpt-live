# Vendored Login with ChatGPT source

This directory pins `opencoredev/login-with-chatgpt` commit
`3befb7fb625170cb305b116a654c7e2f8672bae4` (merged PR #6, “add GPT Live WebRTC
and native tool handoffs”).

OpenHome uses the merged app-server Realtime path rather than treating direct
`/wm` as a tool-capable connection. The app-server supplies structured
`handoff_request` events and `appendSpeech`, while ChatGPT authorization remains
the SDK's device-code flow with no browser-cookie capture.

The source is vendored because the npm `0.2.0` tarballs predate the merged
realtime files. Only `packages/core`, `packages/react`, and `packages/server`
are included.

The integration carries focused server-side patches, each covered by tests:

- forward an explicit working directory and sandbox policy to the Codex thread;
- acknowledge a handoff only after Codex accepts it, while keeping Live usable;
- avoid a `speak_to_user` request/response deadlock with newer app-server builds;
- inject and refresh an owner-local clock snapshot for native time questions;
- answer app-server `currentTime/read` from the live owner clock;
- serialize, deduplicate, and expose Codex handoff lifecycle state;
- guarantee a fallback completion announcement from `turn/completed`;
- disable vague delegated-task filler when the app-server supports that option;
- route selected handoffs to an application-owned OpenAI search callback,
  interrupting the automatically created Codex turn and speaking the result.

These changes are intentionally kept in the vendored boundary so they can be
compared with or proposed back to upstream without mixing in OpenHome code.

Upstream license: MIT; see `LICENSE` in this directory.
