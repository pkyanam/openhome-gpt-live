---
name: openhome-gpt-live
description: Install, configure, update, develop, test, or diagnose the OpenHome GPT Live bridge and Local Ability on macOS or Linux. Use for OpenHome DevKit setup, persistent HTTPS or Cloudflare Tunnel configuration, Login with ChatGPT pairing, GPT Live voice/wake behavior, OpenAI search routing, Codex delegation, Ability packaging/sync, firmware 1.0.8 recovery, or speaker audio and service failures.
---

# OpenHome GPT Live

Operate the integration from its host computer. Keep ChatGPT credentials on the
host and live audio on the speaker. Never install a browser on the DevKit or
capture ChatGPT cookies.

## Start safely

1. Locate an existing checkout, normally `~/.openhome-gpt-live`. If absent,
   clone `https://github.com/pkyanam/openhome-gpt-live.git` there.
2. Run `skills/openhome-gpt-live/scripts/preflight.sh` from the checkout.
3. Read [setup-modes.md](references/setup-modes.md) for installation or tunnel
   work. Read [devkit-runbook.md](references/devkit-runbook.md) only for Ability,
   firmware, audio, wake, or recovery work.
4. Prefer the repository's scripts over ad-hoc commands. Run `./install.sh
   --help`, `bun run setup -- --help`, or `bun run tunnel -- --help` before a
   non-default flow.

## Installation workflow

- New or ordinary interactive setup: run `./install.sh`.
- Agent/non-interactive setup: pass explicit flags to `./install.sh`; never put
  API keys or generated secrets in command-line flags.
- Existing installation: rerun the same installer. It must preserve `.env`,
  `data/`, tunnel credentials, pairing/login state, and the cloud Ability id.
- Treat Codex, OpenHome API automation, and managed Cloudflare Tunnel as
  optional capabilities. Explain what will be unavailable instead of blocking
  the base install.
- Prefer a named, account-linked Cloudflare Tunnel or an existing stable HTTPS
  origin. Label a Quick Tunnel as temporary and never present it as production.
- After host setup, run `bun run finish` for the short OpenHome dashboard and
  pairing handoff.

## Human-only handoffs

Pause only when a person must:

- authorize Cloudflare or choose a DNS hostname;
- create/link OpenHome Third Party Keys, enable the Ability, Sync Abilities, or
  restart the Agent;
- pair the trusted `/setup` browser and authorize ChatGPT by device code;
- approve Full Access or test physical speaker audio.

Give one short numbered list and resume afterward. Do not ask the user to read
raw logs or retrieve the pairing code from speaker audio; use `bun run
pairing:code -- --wait=180`.

## Change and validation workflow

1. Inspect `git status` and preserve unrelated changes.
2. Implement the smallest compatible change.
3. Run `bun run check` and the relevant targeted test.
4. For host-only changes, restart with `bun run service:install`.
5. For Ability changes, upgrade the existing cloud Ability in place. On
   firmware 1.0.8, run `bun run ability:prepare-sync` before dashboard Sync.
6. Run `skills/openhome-gpt-live/scripts/status.sh` and verify one physical wake
   request plus one no-wake negative request when audio gating changed.

## Safety boundaries

- Never print, commit, or transmit `.env`, `data/`, ChatGPT tokens/cookies,
  `LWC_SECRET`, DevKit credentials, tunnel credentials, or API keys.
- Show the bootstrap token only when the owner must paste it into OpenHome.
- Do not delete/recreate a working cloud Ability to upgrade it; installed
  records can retain the deleted id.
- Do not weaken HTTPS, origin checks, email binding, secret lengths, or action
  confirmations to make setup pass.
- Stop `openhome-gpt-live.service` immediately if the speaker enters a response
  loop, then inspect only the private worker log lines needed for diagnosis.

Finish with version, local/public health, host service, Ability package or sync
state, selected voice, wake phrase, Codex mode, and remaining human actions.
