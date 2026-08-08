# Changelog

## 0.1.2 - 2026-08-08

- Track Codex handoffs as explicit running, queued, deduplicated, and completed
  tasks instead of allowing overlapping voice requests to silently replace one
  another.
- Guarantee a spoken completion notice from app-server `turn/completed` even
  when the execution agent omits `speak_to_user`.
- Keep native GPT Live available while Codex works, and let Codex perform a web
  search as a fallback if Live delegates one anyway.
- Answer app-server clock reads from the live host clock and re-arm the DevKit
  on every completed assistant turn, including bridge-appended speech.
- Show Codex busy, queue, and last-task state on the paired-phone page without
  persisting voice transcripts.
- Upgrade an existing OpenHome Ability in place from the CLI while preserving
  its id and linked Third Party Keys.

## 0.1.1 - 2026-08-08

- Prevent non-interactive setup from consuming the remaining input of a
  `curl | bash` installer pipeline.
- Add a regression test that supplies sentinel installer input over stdin.
- Use Bun-aware Dependabot lockfile updates and current GitHub Action majors.

## 0.1.0 - 2026-08-08

- Initial public release.
- Headless GPT Live WebRTC on an OpenHome Local/Background Ability.
- Offline per-request Juniper wake word and PipeWire WebRTC echo cancellation.
- Spoken barge-in, streamed playback, reconnect, and boot persistence.
- Phone-based ChatGPT authorization and consequential-action approvals.
- Codex workspace, confirmed host-control, and owner-authorized Full Access modes.
- Immediate Codex handoff acknowledgement and asynchronous spoken completion.
- Fresh owner-local date/time context for every wake request.
- One-line installer, service manager, doctor, reproducible Ability ZIP, and CI.
