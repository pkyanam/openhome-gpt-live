# Changelog

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
