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
          ├── one-recipient email ─────────────────► OpenAI draft + AgentMail
          └── files / apps / actions ──────────────► Codex
                                                        │
                                                        ▼
                                                  appendSpeech result

Browser /setup control page
  one-time DevKit pairing
  ChatGPT device authorization
  GPT Live voice selection
  wake-name selection
  consequential-action approvals
```

## DevKit plane

The Ability ZIP contains one `openhome-gpt-live/` root with `__init__.py`,
`main.py`, `background.py`, `devkit_functions.py`, `requirements.txt`, and its
README. `background.py` starts with the OpenHome Personality session and keeps
the DevKit worker running. Where systemd is available, the worker also installs
a per-user service so it returns after a power cycle.

PocketSphinx detects the exact configured wake name locally using keyphrase
spotting with a likelihood-ratio threshold. Single-word custom names use a
substantially stricter threshold because they are more prone to false matches.
A one-answer JSGF is deliberately not used because it can force unrelated room
speech into the configured name.
Juniper is the default; voice-name presets and custom English names are
supported. Six accepted wake detections inside two minutes trip a 30-minute
silent cooldown that survives Live reconnects. While armed, the WebRTC
microphone track contains silence. After the wake name, the worker forwards real
microphone frames. During assistant playback the current turn stays open for an
explicit wake-name barge-in. That barge-in opens a replacement backend turn
only after sustained near-end speech clears the measured speaker-echo floor;
rejected echo stays silent. The ordinary gate re-arms only after playback ends.
A timeout closes failed turns even when `/wm` emits no state event. Every new
request and mid-answer interruption requires the wake name. Re-arming changes
only this local microphone gate:
the WebRTC connection and GPT Live conversation remain open, preserving context
across wake-word-gated follow-ups.

The official DevKit path creates a PipeWire-Pulse `module-echo-cancel`
source/sink. The cleaned capture channel goes to GPT Live and remote audio plays
through the paired virtual sink. Barge-in cuts local playback immediately and
sends the native stop-speaking action.

## Host and Login with ChatGPT

The Bun bridge must remain running. It stores encrypted Login with ChatGPT
sessions, hashed device credentials, and browser-pairing state under `data/`.
ChatGPT bearer/refresh material, the OpenHome API key, and the AgentMail API key
never go to the DevKit or browser.

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

- Clock questions remain in GPT Live. The `/wm` app server answers
  `currentTime/read` from the host clock on demand; timestamp metadata is never
  appended as a response-producing wake turn.
- Explicit/current web requests call the authenticated ChatGPT Responses
  endpoint with `tools: [{ type: "web_search" }]`. The parser rejects a result
  unless response usage proves that web search actually ran.
- File, workspace, application, OpenHome, external-action, and explicit “use
  Codex” requests enter the delegated Codex lane. A local action wins when a
  request contains both research and a mutation.
- When the independent `openhome-spotify` service is configured, its supported
  routine music and podcast commands enter a deterministic Spotify lane. The
  Ability owns OAuth, resolution, idempotency, and single-flight playback.
- When `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX` are configured together,
  explicit one-recipient email sends enter a host-owned AgentMail lane. The
  authenticated Responses endpoint converts the exact current voice request
  into a strict subject and plain-text body. The host revalidates every field
  and sends through the selected inbox with a deterministic AgentMail
  `Idempotency-Key`; the key and inbox selection stay on the host.
- Other media-app commands enter the Codex single-flight media lane before
  native or search fallback. Without Spotify configuration, routing is
  unchanged from the standalone GPT Live release.

The DevKit's server-owned wake phrase is removed before this classification.
Each physical wake receives a unique server transaction id. The first handoff
claims exactly one lane owner, and every later handoff in that same wake turn is
suppressed even if GPT Live rephrases it or targets another lane. This prevents
a completed Codex action from later racing a search or another delegated task.

The offline wake gate retains a 500 ms PCM boundary when it opens. This covers
the wake name when PocketSphinx confirms near the end of a combined wake and
prompt utterance. While the boundary is forwarded, every fresh capture frame is
drained into the same bounded delay queue, preventing pipe backpressure from
discarding the rest of the prompt. Armed room audio is still replaced with
silence and never leaves the speaker.

The bridge uses client-managed handoffs, so web search and AgentMail do not
create Codex turns. Each lane acknowledges immediately, runs independently,
and sends its speech-friendly result through `thread/realtime/appendSpeech`.
AgentMail keeps active and recent request guards in the Live session, while its
provider key is derived from the selected sender and normalized voice request.
An ambiguous failure tells the owner to check AgentMail instead of encouraging
an unsafe blind retry.

Each Codex request gets a new ephemeral app-server thread and may run in
parallel, with a four-task safety limit. Acceptance and its spoken acknowledgement
happen before task-thread startup. The DevKit consumes that acceptance event and
re-arms the physical wake gate, so a slow Codex launch cannot trip the 15-second
silent-response watchdog or block another Lara request. Handoffs are deduplicated,
completion events are correlated by thread id, and each task gets a spoken
fallback if its execution agent omits `speak_to_user`.

Media playback is a single-flight sub-lane. Codex receives the user's exact
request and chooses its tools. The bridge rejects replayed handoffs and exact
repeated actions, tells Codex to reuse one relevant tab and start one stream,
caps the turn at eight actionable items or 90 seconds, and interrupts execution
when `speak_to_user` reports completion or a tool result confirms active
playback. Other direct computer-control turns stop after 20 actions or two
minutes; ordinary delegated work stops after five minutes.

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
cookie. An authenticated control surface can issue a 15-minute code for another
browser; the registry keeps up to eight hashed browser claims, so adding a phone
does not sign out the original host browser. It can complete ChatGPT device authorization, approve pending actions,
select one of the SDK's nine known GPT Live voices, and choose a wake-name
preset or custom English name. It may run on the host, another computer, a
phone, or a tablet; it is not an OpenHome-mobile surface. A settings change
updates the server-owned device record and closes the current Live session. The
DevKit watchdog reconnects, reads both settings through its device credential,
and rebuilds the local wake detector. Voice and wake name remain independent.

## Lifecycle

- Host launchd/systemd restarts the Bun bridge after failure or reboot.
- DevKit systemd/OpenHome monitoring restarts the audio worker.
- GPT Live sessions remain open through ordinary idle periods. The host owns a
  12-hour safety TTL, the DevKit fallback expires slightly later, and either an
  upstream close or the safety rotation reconnects automatically without a
  manual trigger.
- Exact clock reads come from the host on demand without turn injection.
- Disabling the Ability and restarting the Agent stops the provider.
- A stable HTTPS hostname is required; a changing tunnel URL strands the
  DevKit on its old server address.
