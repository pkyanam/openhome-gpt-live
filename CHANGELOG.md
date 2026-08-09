# Changelog

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
