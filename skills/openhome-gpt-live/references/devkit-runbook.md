# DevKit runbook

## Supported topology

- Official OpenHome DevKit; firmware 1.0.8 is physically tested.
- A macOS or Linux host runs the HTTPS bridge and Codex tools.
- The DevKit runs the Local Ability, offline Juniper wake gate, WebRTC audio,
  and acoustic echo cancellation.

## Ability lifecycle

- New Ability: upload `dist/openhome-gpt-live-ability.zip` (one top-level
  directory).
- Existing Ability release: upload `dist/openhome-gpt-live-release.zip` (files
  at ZIP root).
- With `OPENHOME_API_KEY`, use `bun run upload:ability` to preserve the Ability
  id and linked Third Party Keys.
- Firmware 1.0.8 upgrade: run `bun run ability:prepare-sync`, reconnect the
  dashboard, Sync Abilities, and restart the Agent.
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

Codex tasks are serialized. GPT Live should acknowledge the handoff promptly
and announce completion. Search must remain available while Codex is busy.

## Audio and wake checks

- Require “Juniper” for every new request, including barge-in.
- Keep the same Live session so context survives between gated turns.
- If speaker playback re-triggers Juniper, stop the worker; this is a safety
  failure, not harmless transcription noise.
- After audio changes, test one short wake request, wait for re-arm, then speak
  a question without Juniper and confirm the activation count does not change.
