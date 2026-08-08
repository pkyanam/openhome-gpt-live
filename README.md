# OpenHome GPT Live

Turn an OpenHome DevKit into a wake-word GPT Live speaker with Codex tool
access. Say **“Juniper, …”** for each request. Voice runs directly between the
DevKit and the ChatGPT account you authorize; Codex can work in a folder on
your computer and report back through the speaker.

No OpenAI API key is used. No Chromium, display, mouse, or keyboard is needed
on the DevKit. ChatGPT authorization happens on your phone.

> [!IMPORTANT]
> This is an independent, self-hosted integration—not an OpenHome or OpenAI
> product. It uses the experimental GPT Live transport merged in
> [`login-with-chatgpt` PR #6](https://github.com/opencoredev/login-with-chatgpt/pull/6).
> Private upstream transport changes can require a project update.

## What you need

- An onboarded OpenHome DevKit with Local Abilities. Firmware **1.0.8 is tested**;
  1.1.0 is not required.
- A ChatGPT account whose subscription has GPT Live and Codex access.
- An always-on macOS or Linux computer on the internet, with `codex` installed
  and signed in. Mac control requires macOS; workspace tasks work on either OS.
- A stable public HTTPS hostname that forwards to `http://127.0.0.1:3000` on
  that computer. A Cloudflare Tunnel is the easiest durable option. See
  [Stable HTTPS setup](docs/STABLE-HTTPS.md).
- An OpenHome API key if you want automatic Ability upload or OpenHome account
  tools. Voice itself can work without that key.

The official DevKit is the supported full-duplex target. OpenHome OS on a
custom Raspberry Pi may need different audio-device settings, and OpenHome's
own documentation says interruption is not supported on custom Pi hardware.

## Install

Run this on the computer that will stay online:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash
```

The installer:

1. downloads or safely updates the project;
2. installs Bun if needed and verifies Codex support;
3. asks for your ChatGPT email, stable HTTPS URL, workspace, and access mode;
4. generates private enrollment/encryption secrets;
5. runs all TypeScript and DevKit tests and builds a validated Ability ZIP;
6. installs an always-on launchd or systemd service;
7. uploads the Ability when an OpenHome API key was supplied.

It installs under `~/.openhome-gpt-live` by default. Re-running the same command
performs a safe update and keeps `.env`, paired-device state, and ChatGPT login
state.

## Finish in OpenHome

The installer prints the two values you need. You can print them again with:

```bash
cd ~/.openhome-gpt-live
bun run openhome:config
```

Then use the [OpenHome Dashboard](https://app.openhome.com):

1. Open **Settings → API Keys → Third Party Keys**.
2. Create `openhome_gpt_live_server_url` and paste the printed HTTPS URL.
3. Create `openhome_gpt_live_bootstrap_token` and paste the printed enrollment
   token. Link both keys to **OpenHome GPT Live**.
4. Open **My Abilities**. If the installer did not upload it, upload
   `~/.openhome-gpt-live/dist/openhome-gpt-live-ability.zip` as a **Local**
   Ability. Install it on the active Agent and enable it.
5. Prevent the built-in OpenHome voice from answering at the same time: in
   **Settings → Configuration**, enable its wake word and change it to a reserved
   recovery phrase such as `openhome fallback seven nine`.
6. In the DevKit app or dashboard, tap **Sync Abilities**, then **Restart Agent**.

After the restart, the speaker announces a setup URL and eight-digit code. Open
that `/setup` page on your phone, enter the code, tap **Open ChatGPT
authorization**, and authorize the intended ChatGPT account. Leave the page
available only if you selected phone-confirmed computer control.

Test it with:

> “Juniper, what is the exact date and time right now?”

Then try a Codex task:

> “Juniper, create a small web game in my workspace and tell me when it is done.”

“Juniper” is required for every new request, including interruptions. The
DevKit keeps only an offline wake-word detector active while armed; it forwards
microphone audio to GPT Live only after the wake phrase is detected.

## Access modes

The installer defaults to **workspace only**.

| Mode | What voice-started Codex can do |
| --- | --- |
| Workspace only | Read, create, edit, and test inside the configured folder. |
| Phone confirmed | Workspace tasks run directly; broader host-computer tasks wait for approval on `/setup`. |
| Full Access | Runs delegated Codex with `danger-full-access` and no approval prompt. The owner assumes the risk. |

Change the mode later with `bun run setup`, then restart the service:

```bash
bun run service:install
```

## Health and maintenance

```bash
cd ~/.openhome-gpt-live
bun run doctor -- --require-server
bun run service:status
curl http://127.0.0.1:3000/healthz
```

Useful guides:

- [Troubleshooting by symptom](docs/TROUBLESHOOTING.md)
- [Manual installation and upgrades](docs/MANUAL-INSTALL.md)
- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Security model](SECURITY.md)

## How it works

The uploaded package is both an OpenHome **Local Ability** and a
`background.py` daemon. It installs a headless Python WebRTC worker on the
DevKit, performs offline wake-word detection, and uses PipeWire's WebRTC echo
canceller for barge-in. The long-lived Bun bridge keeps ChatGPT credentials on
the host, opens Codex app-server handoffs, and exposes only allowlisted tools.

The vendored SDK is pinned to upstream commit
[`3befb7f`](https://github.com/opencoredev/login-with-chatgpt/commit/3befb7fb625170cb305b116a654c7e2f8672bae4),
the merge commit for the voice PR. Its MIT license and the small integration
patch list are in [`vendor/login-with-chatgpt/UPSTREAM.md`](vendor/login-with-chatgpt/UPSTREAM.md).

## Give this setup to a local coding agent

Copy the prompt below into Codex or another local coding agent running on the
macOS or Linux computer that will host the bridge. The agent should do all
terminal work and pause only for account, browser, DNS, or physical-speaker
steps that require you.

```text
Set up OpenHome GPT Live end to end on this computer.

Source repository:
https://github.com/pkyanam/openhome-gpt-live

Objective:
Install the long-lived host bridge, build and validate the OpenHome Local
Ability, connect it through a stable HTTPS origin, help me complete the few
required OpenHome/ChatGPT browser steps, and verify a real “Juniper” voice turn
plus a Codex workspace task. Continue autonomously until the integration works
or a genuinely human-only step is required.

Operating rules:
- First read README.md, SECURITY.md, docs/STABLE-HTTPS.md,
  docs/MANUAL-INSTALL.md, and docs/TROUBLESHOOTING.md from the checked-out
  repository. Follow any local AGENTS.md instructions.
- Inspect the current machine before changing it. Preserve an existing .env,
  data directory, paired-device state, tunnel configuration, and unrelated
  user changes. Never delete or replace an existing OpenHome Ability merely to
  upgrade it.
- Never print or commit LWC_SECRET, OPENHOME_API_KEY, ChatGPT tokens, cookies,
  device credentials, tunnel credentials, or files from data/. The DevKit
  bootstrap token may be shown only when I need to paste it into OpenHome.
- Do not install a browser on the DevKit. ChatGPT authorization belongs on my
  phone or normal computer browser.
- Do not claim production readiness with a temporary trycloudflare URL. A
  stable HTTPS hostname must survive host and tunnel restarts. If I do not have
  one, explain the shortest Cloudflare Tunnel setup and hand off only the
  Cloudflare login/DNS confirmation that requires me.
- Default Codex to workspace-only access. Ask me before selecting phone-
  confirmed host control or Full Access. Full Access requires an explicit risk
  acknowledgement.
- Do not weaken HTTPS, account-email binding, origin checks, secret lengths, or
  tool confirmation boundaries to make a check pass.

Execution checklist:
1. Confirm this is macOS or Linux and that git, curl, Python 3, Bun, and Codex
   are usable. Install Bun when absent. If Codex is absent or logged out, hand
   off only its installation/login and resume afterward.
2. Clone the repository to ~/.openhome-gpt-live, or safely fast-forward an
   existing checkout. Run `bun install --frozen-lockfile` and `bun run check`.
3. Collect only missing configuration: the ChatGPT account email, stable public
   HTTPS origin, Codex workspace, desired access mode, and optional OpenHome API
   key. Run `bun run setup`; let it preserve/generate private secrets. Do not
   rotate existing secrets without explaining that pairing/login state will be
   invalidated.
4. Verify the HTTPS origin routes to 127.0.0.1:3000 and supports the long-lived
   bridge. Install/restart the host service with `bun run service:install`.
5. Run `bun run doctor -- --require-server`. Fix every failure. Warnings may be
   accepted only with a concrete explanation.
6. If OPENHOME_API_KEY is configured and the Ability does not already exist,
   run `bun run upload:ability`. If it already exists, update it in place; do
   not create a duplicate or delete the installed object. The release ZIP is
   `dist/openhome-gpt-live-ability.zip`.
7. Print `bun run openhome:config` and hand off these human-only OpenHome steps:
   create/link the two exact Third Party Keys, install/enable the Local Ability
   on the active Agent, set the built-in Agent wake word to a reserved recovery
   phrase, then Sync Abilities and Restart Agent. Give one short numbered list,
   wait for me to finish it, and then continue.
8. When the DevKit announces or exposes its setup URL and eight-digit code,
   hand off phone pairing and ChatGPT device authorization. Do not ask me for a
   ChatGPT bearer token. Wait for me to report that /setup shows the device
   authenticated and ChatGPT connected.
9. Verify the host health endpoint, public health endpoint, service status,
   OpenHome Ability state, and safe DevKit live_status output. Never expose the
   device config file.
10. Ask me to say: “Juniper, what is the exact date and time right now?” Confirm
    one spoken answer. Then ask me to say: “Juniper, create a small test file in
    my workspace and tell me when it is done.” Confirm the immediate handoff
    acknowledgement, continued voice availability while Codex works, and the
    final spoken completion.
11. If anything fails, diagnose by symptom using docs/TROUBLESHOOTING.md, make
    safe host/source fixes that are within scope, rerun relevant tests, rebuild
    the Ability if its source changed, and hand off only the required OpenHome
    sync/restart action.

Completion report:
State the installed version/commit, host service status, stable public health
status, Ability package checksum, selected access mode, configured workspace,
and the two successful spoken tests. Do not include secrets or tokens.
```

## Development

```bash
git clone https://github.com/pkyanam/openhome-gpt-live.git
cd openhome-gpt-live
bun install
cp .env.example .env
bun run check
```

`bun run package:ability` produces a reproducible, single-root ZIP plus SHA-256
checksum in `dist/`. Pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
