# Architecture

```text
OpenHome DevKit
  PocketSphinx wake word
  PipeWire echo cancellation
  aiortc microphone + speaker
          │ authenticated SDP through the host
          │ direct WebRTC media after negotiation
          ▼
ChatGPT GPT Live
          │ structured handoff_request
          ▼
Login with ChatGPT app-server bridge on the owner's computer
          ├── ordinary conversation ───────────────► GPT Live
          ├── current information ─────────────────► OpenAI web_search
          └── files / apps / actions ──────────────► Codex
                                                        │
                                                        ▼
                                                  appendSpeech result

Browser /setup control page
  one-time DevKit pairing
  ChatGPT device authorization
  GPT Live voice selection
  consequential-action approvals
```

## DevKit plane

The Ability ZIP contains one `openhome-gpt-live/` root with `__init__.py`,
`main.py`, `background.py`, `devkit_functions.py`, `requirements.txt`, and its
README. `background.py` starts with the OpenHome Personality session and keeps
the DevKit worker running. Where systemd is available, the worker also installs
a per-user service so it returns after a power cycle.

PocketSphinx detects the configured wake phrase locally. While armed, the
WebRTC microphone track contains silence. After “Juniper,” the worker forwards
real microphone frames until the assistant turn completes, then re-arms. Every
new request and mid-answer interruption requires the wake phrase.

The official DevKit path creates a PipeWire-Pulse `module-echo-cancel`
source/sink. The cleaned capture channel goes to GPT Live and remote audio plays
through the paired virtual sink. Barge-in cuts local playback immediately and
sends the native stop-speaking action.

## Host and Login with ChatGPT

The Bun bridge must remain running. It stores encrypted Login with ChatGPT
sessions, hashed device credentials, and browser-pairing state under `data/`.
ChatGPT bearer/refresh material and the OpenHome API key never go to the DevKit
or browser.

The DevKit sends an SDP offer to the authenticated app-server Realtime route.
The vendored SDK starts an isolated Codex app-server process with the signed-in
ChatGPT subscription, calls `thread/realtime/start`, and returns the SDP answer.
The app-server mediates structured handoffs and appended speech; the WebRTC
media plane remains between the DevKit and ChatGPT.

This is intentionally not the standalone direct `/realtime/wm` proxy. The
app-server route is what provides reliable `handoff_request`, interruption,
background execution, and `appendSpeech` behavior without scraping raw data
channel transcripts or capturing ChatGPT browser cookies.

## Routing and tool planes

The host classifies every native handoff before Codex accepts it:

- Clock questions return to GPT Live, which receives a fresh owner-local clock
  context for every wake request.
- Explicit/current web requests call the authenticated ChatGPT Responses
  endpoint with `tools: [{ type: "web_search" }]`. The parser rejects a result
  unless response usage proves that web search actually ran.
- File, workspace, application, OpenHome, external-action, and explicit “use
  Codex” requests enter the delegated Codex lane. A local action wins when a
  request contains both research and a mutation.

The automatically created Codex search turn is interrupted before execution.
The search lane acknowledges immediately, runs independently, and sends its
speech-friendly result through `thread/realtime/appendSpeech`. It never invokes
local Codex.

Codex work is serialized, deduplicated, and isolated into individual turns.
The bridge acknowledges accepted work, publishes busy/queue state to GPT Live,
and guarantees a spoken completion fallback if the execution agent omits its
own `speak_to_user` call.

OpenHome mutations use prepare/review/confirm. Workspace-only Codex uses
`workspace-write`. Browser-confirmed host actions run outside the workspace only
after `/setup` approval. Full Access deliberately uses `danger-full-access`
with approval policy `never`.

## Pairing and voice settings

Device enrollment returns an eight-digit pairing code valid for 15 minutes.
Only its hash is stored in the device registry. A separate mode-0600 local
inbox retains the raw code for `bun run pairing:code`; it is removed on claim or
expiry. The helper prints a one-click `/setup#pairing=…` link, so speaker audio
and log access are optional.

The browser profile opened to `/setup` receives a distinct HttpOnly pairing
cookie. It can complete ChatGPT device authorization, approve pending actions,
and select one of the SDK's nine known GPT Live voices. It may run on the host,
another computer, a phone, or a tablet; it is not an OpenHome-mobile surface.
A voice change updates server-owned device settings and closes the current Live
session. The DevKit watchdog reconnects, reads the new setting through its
device credential, and negotiates the new voice. Wake phrase configuration
remains independent.

## Lifecycle

- Host launchd/systemd restarts the Bun bridge after failure or reboot.
- DevKit systemd/OpenHome monitoring restarts the audio worker.
- GPT Live sessions rotate after 30 minutes and reconnect automatically.
- A fresh owner-local clock context is injected for every wake request.
- Disabling the Ability and restarting the Agent stops the provider.
- A stable HTTPS hostname is required; a changing tunnel URL strands the
  DevKit on its old server address.
