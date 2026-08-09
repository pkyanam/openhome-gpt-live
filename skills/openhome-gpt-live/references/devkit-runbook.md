# DevKit runbook

## Supported topology

- Official OpenHome DevKit; firmware 1.0.8 and 1.1.1 are physically tested.
- A macOS or Linux host runs the HTTPS bridge and Codex tools.
- The DevKit runs the Local Ability, configurable offline wake gate, WebRTC audio,
  and acoustic echo cancellation.

## Ability lifecycle

- New Ability: upload `dist/openhome-gpt-live-ability.zip` (one top-level
  directory).
- Existing Ability release: upload `dist/openhome-gpt-live-release.zip` (files
  at ZIP root).
- With `OPENHOME_API_KEY`, use `bun run upload:ability` to preserve the Ability
  id and linked Third Party Keys.
- Run `bun run ability:prepare-sync` after an Ability upload. Firmware 1.1.1
  uses its device-native capability sync and restarts the provider
  automatically; firmware 1.0.8 asks for dashboard Sync and Agent restart.
- If the background provider did not start, send `gpt live diagnostics` once in
  Activity. It is a firmware bootstrap, not a normal voice launch phrase.

## Safe status and recovery

Run `skills/openhome-gpt-live/scripts/status.sh`. If the OpenHome API key is
available, the repository's `scripts/devkit-command.ts` may run narrowly scoped
service and log commands. Never read or expose the DevKit configuration file.

For a runaway response loop, immediately stop the DevKit worker:

```bash
bun scripts/devkit-command.ts 'systemctl --user stop openhome-gpt-live.service'
```

Inspect only the needed tail of
`~/.local/share/openhome-gpt-live/worker.log`. Keep the service off until one
controlled positive wake test and one no-wake negative test pass.

## Expected routing

- Conversation, explanations, and clock: GPT Live.
- Current facts and simple searches: OpenAI subscription web search.
- Files, code, projects, OpenHome actions, and computer control: Codex.
- Media playback and controls for YouTube, Spotify, and Apple Music: Codex's
  single-flight media lane.

The configured wake phrase is stripped before routing. Every physical wake has
one server transaction, and its first accepted handoff has one owner. A later
rephrased handoff in that wake turn must never race a search or Codex completion.

Codex tasks run in isolated threads, up to four in parallel. GPT Live should
acknowledge every handoff before task-thread startup, immediately re-arm the
physical wake gate, and announce each completion. Search and new wake requests
must remain available while Codex tasks run.

Media playback is single-flight. Codex receives the exact request and chooses
its own tools. It may reuse or open one browser tab and start one stream. A
verified playback result or completion speech terminates the turn, and an exact
repeated action is blocked. Expect media tasks to stop at eight actions or 90
seconds, direct computer tasks at 20 actions or two minutes, and ordinary
delegated tasks at five minutes.

## Audio and wake checks

- Require the configured wake name for every new request, including barge-in.
- A wake name and prompt spoken as one utterance must work on the first attempt.
  The worker should report 500 ms of buffered wake audio while continuing to
  drain fresh capture into a bounded delay queue.
- Wake detection must use keyphrase spotting, never a one-answer grammar. Six
  accepted detections inside two minutes must enter a silent 30-minute cooldown
  that persists across Live reconnects.
- While GPT Live runs, verify the firmware Chromium capture and playback
  streams are muted; the Ability watchdog must reapply this after restarts.
- Keep the same Live session so context survives between gated turns.
- If speaker playback re-triggers the wake gate, stop the worker; this is a safety
  failure, not harmless transcription noise.
- After audio changes, test one short wake request, wait for re-arm, then speak
  a question without the wake name and confirm the activation count does not change.
