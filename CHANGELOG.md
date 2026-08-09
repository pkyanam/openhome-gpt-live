# Changelog

## 0.3.9 - 2026-08-09

- Preserve a 500 ms wake boundary so a combined `Lara, <prompt>` utterance is
  still available when the offline decoder confirms the wake name near the end
  of the phrase.
- Drain fresh microphone capture into a bounded delay queue while forwarding
  that boundary. This prevents capture-pipe backpressure without discarding the
  request that follows the wake name.
- Replace simultaneous 30-minute host and DevKit expiry timers with one
  host-owned 12-hour safety lifecycle and a slightly later device fallback.
  Live remains available through ordinary idle periods and reconnects
  automatically when the provider or safety lifecycle closes a call.
- Add regression coverage for retained wake context, bounded continuous
  capture, and the staggered long-lived session fallback.
- Acknowledge Codex acceptance before task-thread startup and re-arm the DevKit
  wake gate on accepted Codex or OpenAI search work. Long prompts and slow task
  launches no longer trip the 15-second silence watchdog or close the Live call.
- Replace the one-answer wake grammar, which could force ordinary room audio
  into “Lara,” with PocketSphinx keyphrase spotting and a stricter likelihood
  threshold. Add a reconnect-persistent safety cooldown after six wake
  detections in two minutes, plus timestamps for future private diagnostics.

## 0.3.8 - 2026-08-09

- Fix the silent first request when a user says the wake name and prompt as one
  natural utterance.
- Reduce wake audio replay from 500 ms to an 80 ms tail. This preserves the
  beginning of an immediate prompt without pausing capture long enough to fill
  the DevKit audio pipe and discard fresh speech.
- Add bounded-preroll regression coverage and safe wake-buffer telemetry that
  records duration only, never microphone content or transcripts.

## 0.3.7 - 2026-08-09

- Bind every physical wake event to one server-enforced routing transaction.
  The first native, search, or Codex handoff owns that turn, and later
  rephrased handoffs cannot escape into another lane.
- Give Codex only the exact current delegated request. Prior assistant speech
  is no longer injected as execution context or inferred as another action.
- Stop exact repeated computer actions before a second execution and end a
  media task as soon as its own tool result confirms playback is active.
- Tighten media tasks to eight actionable items while preserving independent,
  parallel Codex threads and leaving tool selection to each Codex agent.
- Add end-to-end protocol, DevKit proxy, Ability, playback, and replay
  regression coverage for the new wake transaction boundary.

## 0.3.6 - 2026-08-09

- Give every handoff one exclusive owner: native GPT Live, authenticated OpenAI
  web search, or an isolated Codex task.
- Route YouTube, Spotify, Apple Music, songs, playlists, and playback controls
  directly to the bounded Codex media lane before native or search fallback.
- Remove the configured wake name before routing, search, or delegated
  execution so custom wake names cannot distort intent classification.
- Silently suppress repeated native fallback handoffs instead of speaking a
  contradictory “native web access is unavailable” refusal.
- Use one shared application classifier for Codex routing and media safety
  contracts, shorten media acknowledgements, and forbid duplicate Live speech
  after a handoff is accepted.
- Complete the browser SDK lifecycle-event parser and add routing matrix,
  wake-normalization, lane-deduplication, and settings propagation coverage.

## 0.3.5 - 2026-08-09

- Make browser media playback single-flight so repeated or slightly different
  handoffs cannot start concurrent songs, videos, tabs, or windows.
- Give media tasks a strict one-tab, one-result, one-stream execution contract
  and require Codex to stop as soon as playback begins.
- Treat `speak_to_user` as a terminal boundary and interrupt the Codex turn after
  its final acknowledgement so computer use cannot continue clicking afterward.
- Stop media tasks after 90 seconds or 12 actions, direct computer tasks after
  two minutes or 20 actions, and ordinary delegated tasks after five minutes.
- Suppress late tool calls from already completed task threads and add coverage
  for replay deduplication, terminal speech, interaction caps, and deadlines.

## 0.3.4 - 2026-08-09

- Start every delegated request in its own ephemeral Codex thread, with up to
  four concurrent tasks instead of one blocking FIFO queue.
- Correlate dynamic tools, speech, and completion notices by execution thread so
  parallel tasks cannot overwrite or delay each other's results.
- Use client-managed realtime handoffs so OpenAI web search and native retries
  remain independent of every running Codex task.
- Suppress the firmware dashboard's Chromium microphone and speaker streams
  while GPT Live owns audio, and continuously reapply the reversible mute after
  firmware or browser restarts.
- Show active Codex task count on the setup page and refresh the runbook,
  architecture, troubleshooting, skill, package, and release metadata.

## 0.3.3 - 2026-08-09

- Keep the boot worker in the persistent GPT Live state directory instead of
  OpenHome's firmware-managed runtime tree. A firmware replacement can no
  longer delete the executable behind an apparently running systemd service.
- Detect firmware v1.1.1's official `devkit_cmd.py sync-capabilities` support
  and let the post-upload sync command complete Ability sync plus provider
  restart automatically. Firmware 1.0.8 retains the safe
  archive-and-manual-Sync fallback.
- Allow up to five minutes for v1.1.1's dependency reinstall and 15-second
  provider boot guard so a successful device sync is not reported as a timeout.
- Record successful physical upgrade coverage from v1.0.8 to v1.1.1, including
  restoration of the cloud Ability without losing pairing, ChatGPT auth, Vale,
  Lara, Codex configuration, or host state.
- Prevent GPT Live's own speech from creating intermittent mid-sentence holes:
  wake-to-interrupt now requires sustained near-end speech in addition to the
  exact offline wake match. Ordinary armed wake detection is unchanged.
- Add a bounded 160 ms remote-audio jitter cushion and rate-limited frame-gap
  telemetry so short scheduling/network gaps do not become audible word breaks
  and longer upstream gaps are diagnosable.
- Refresh the installer handoff, agent skill, manual, issue template, README,
  and project site for the tested 1.0.8 and 1.1.1 firmware paths.

## 0.3.2 - 2026-08-09

- Detect a `/wm` transport that remains nominally connected after native web
  search but stops accepting later microphone turns.
- Recycle that stale Live session after one authenticated request receives no
  assistant audio, instead of repeatedly re-arming a permanently dead call.
- Surface the recovery as `reconnecting`; pairing, ChatGPT authorization,
  selected voice, wake name, and host configuration remain intact.
- Add **Pair another browser** to the authenticated setup page. A short-lived
  code authorizes a phone, tablet, or second computer without moving ChatGPT
  credentials into that browser or invalidating existing control surfaces.
- Reduce custom wake-name latency by confirming three exact decoder hits inside
  an 800 ms window while tolerating brief blank decoder frames. Wrong phrases,
  low-confidence matches, speaker playback, and expired candidates still reset
  or reject the wake.
- Route asset price and pricing questions such as Bitcoin to the subscription's
  hosted OpenAI search lane, require an actual `web_search` call, and log routing
  plus completion/failure timing for diagnostics.

## 0.3.1 - 2026-08-08

- Fixed a runaway false-wake loop where speaker/ambient audio was accepted as
  broad “Juniper” phonetic aliases and repeatedly activated GPT Live.
- Removed per-wake developer timestamp injection, which could make `/wm`
  recite the date/time instead of answering the owner's actual request.
- Exact date/time now comes from the app-server's on-demand
  `currentTime/read` provider without creating a realtime turn.
- Kept the active request gate through assistant playback so explicit
  wake-name barge-in remains available without reopening the ordinary detector
  into the speaker's own audio.
- Added server-owned voice and wake-name settings to `/setup`, including all
  nine voice names as presets and validated custom English names.
- Added `--wake-name` to interactive and non-interactive setup, and updated the
  installer, finish handoff, Ability, project site, agent skill, and docs.

## 0.3.0 - 2026-08-08

- Replace fragmented onboarding with an idempotent interactive installer,
  explicit flags and help, resumable `bun run finish` handoff, and safe
  preservation of local configuration and cloud Ability identity.
- Add existing-HTTPS, persistent named Cloudflare Tunnel, temporary Quick
  Tunnel, and configure-later modes. The named tunnel path installs a user
  launchd/systemd service without replacing global Cloudflare configuration.
- Make Codex, OpenHome API automation, managed tunneling, and local Python
  packaging optional when their capabilities are not needed.
- Add a Codex-compatible repository plugin and concise OpenHome GPT Live skill
  with reusable preflight, status, setup-mode, and DevKit recovery resources.
- Replace the long agent prompt with a two-line skill handoff beside the
  one-command installer.
- Add a responsive, interactive GitHub Pages marketing and documentation site
  using reference-faithful OpenHome DevKit artwork, plus automated Pages
  deployment and CI validation.

## 0.2.7 - 2026-08-08

- Prevent GPT Live's own spoken response from being accepted as a new Juniper
  wake while speaker playback is active. A wake during playback now requires
  both an offline wake-word match and independently strong near-end audio.
- Add regression coverage for speaker-echo rejection while preserving genuine
  wake-word barge-in and normal wake detection when the speaker is quiet.
- Validate the fix on an official DevKit running firmware 1.0.8 with the exact
  former failure case, followed by a no-wake negative room-audio check.

## 0.2.6 - 2026-08-08

- Fix the OpenHome release uploader to publish the actual new Ability code
  through the dashboard's flat-ZIP release endpoint while preserving the
  existing Ability id and linked keys.
- Restore the background-provider class name required by the firmware loader.
- Keep the offline Juniper detector responsive after long armed periods,
  tighten false-wake rejection, and verify positive/negative room audio on an
  official DevKit running firmware 1.0.8.
- Re-arm from observed remote audio plus near-end request silence when `/wm`
  omits data-channel state events, requiring Juniper for every request without
  clipping a one-breath prompt.
- Preserve the Live conversation during local wake-word barge-in, add a safe
  firmware-1.0.8 cache preparation command, and publish both OpenHome ZIP
  formats in CI.
- Document the one-time Activity diagnostics bootstrap required because
  firmware 1.0.8 does not reliably invoke Local Ability background providers
  when the Agent restarts.

## 0.2.5 - 2026-08-08

- Preserve the open microphone gate and queued replacement request when the
  interrupted assistant response emits a late completion event.
- Add regression coverage for the explicit turn-completion/barge-in event order.

## 0.2.4 - 2026-08-08

- Re-arm the local Juniper microphone gate after every GPT Live response across
  all `/wm` ready-state transitions, not only `speaking -> listening`.
- Clear buffered wake-detector audio at each turn boundary so stale audio cannot
  silently reopen the microphone.
- Preserve the same GPT Live WebRTC session while re-arming, retaining the full
  conversation context between wake-word-gated requests.

## 0.2.3 - 2026-08-08

- Replace phone-specific setup language with the accurate browser control-page
  model. `/setup` can run in any trusted browser on the host, another computer,
  a phone, or a tablet and is not embedded in the OpenHome mobile app.

## 0.2.2 - 2026-08-08

- Make the browser control page's saved voice authoritative during every Live
  negotiation. The host now replaces a stale DevKit voice before forwarding
  the session to GPT Live, so an older local configuration cannot roll Vale or
  another selected voice back to Juniper.

## 0.2.1 - 2026-08-08

- Reconnect GPT Live inside the long-running DevKit worker after a voice change,
  session expiry, or recoverable connection failure instead of depending on an
  external service manager to relaunch a one-session process.
- Show `reconnecting` in the paired browser while the old voice session is being
  replaced.

## 0.2.0 - 2026-08-08

- Keep the verified Login with ChatGPT app-server transport as the single GPT
  Live path; remove the abandoned direct-`/wm` signaling experiment.
- Route explicit/current requests to the signed-in ChatGPT subscription's
  first-party `web_search` tool, interrupting the automatic Codex turn and
  speaking results through GPT Live.
- Keep file, project, OpenHome, application, and computer actions in the
  serialized Codex handoff lane with immediate acknowledgement and guaranteed
  completion speech.
- Add a paired-browser picker for Arbor, Breeze, Cove, Ember, Juniper, Maple, Sol,
  Spruce, and Vale. Vale is the new-device default; speaking voice and wake
  phrase remain independent.
- Persist the selected voice server-side and reconnect GPT Live automatically
  after a change.
- Add `bun run pairing:code -- --wait=180`, backed by a private 15-minute inbox,
  so setup never depends on speaker audio or raw log inspection.
- Rewrite installation, architecture, troubleshooting, Ability, security, and
  coding-agent documentation around the live-verified production flow.

## 0.1.2 - 2026-08-08

- Track Codex handoffs as running, queued, deduplicated, and completed tasks.
- Guarantee a spoken completion notice when the execution agent omits
  `speak_to_user`.
- Answer app-server clock reads from the live host clock and re-arm the DevKit
  after each completed assistant turn.
- Upgrade an existing OpenHome Ability in place while preserving its id and
  linked Third Party Keys.

## 0.1.1 - 2026-08-08

- Prevent non-interactive setup from consuming remaining `curl | bash` input.
- Add a regression test for piped installer input.
- Use Bun-aware Dependabot lockfile updates and current GitHub Action majors.

## 0.1.0 - 2026-08-08

- Initial public release.
- Headless GPT Live WebRTC on an OpenHome Local/Background Ability.
- Offline per-request Juniper wake word and PipeWire echo cancellation.
- Browser-based ChatGPT authorization and consequential-action approvals.
- Codex workspace, confirmed host-control, and Full Access modes.
- One-line installer, service manager, doctor, reproducible ZIP, and CI.
