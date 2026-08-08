# OpenHome GPT Live

Turn an OpenHome DevKit into a wake-word GPT Live speaker with OpenAI web
search and local Codex tool access. Say **“Juniper, …”** before every request.

- GPT Live owns speech, ordinary conversation, and general knowledge.
- OpenAI's first-party `web_search` handles current information.
- Codex handles files, projects, applications, and computer actions.
- ChatGPT authorization happens on your phone with a device code.
- No OpenAI API key, ChatGPT cookie capture, Chromium, display, keyboard, or
  mouse is needed on the DevKit.

> [!IMPORTANT]
> This is an independent, self-hosted integration—not an OpenHome or OpenAI
> product. It uses the experimental GPT Live support merged in
> [`login-with-chatgpt` PR #6](https://github.com/opencoredev/login-with-chatgpt/pull/6).
> A private upstream protocol change can require a project update.

## Requirements

- An onboarded OpenHome DevKit with Local Abilities. Firmware **1.0.8 is
  tested**; 1.1.0 is not required.
- A ChatGPT subscription with GPT Live and Codex access.
- An always-on macOS or Linux host computer with Codex installed and signed in.
  Workspace tasks work on either OS; Mac app control requires macOS.
- A stable public HTTPS hostname forwarding to `http://127.0.0.1:3000` on the
  host. See [Stable HTTPS setup](docs/STABLE-HTTPS.md).
- An OpenHome API key only if you want automatic Ability upload or OpenHome
  account tools. Voice, web search, and local Codex do not require it.

The official DevKit is the supported full-duplex target. Custom Raspberry Pi
audio may require manual devices and may not support interruption as well.

## Install the host

Run this on the computer that will stay online:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash
```

The installer downloads or updates the project, installs dependencies, gathers
the small amount of configuration it needs, runs the full test suite, builds a
valid Ability ZIP, installs a launchd/systemd service, and uploads or upgrades
the Ability when an OpenHome API key is available.

The default location is `~/.openhome-gpt-live`. Re-running the command updates
in place while preserving `.env`, device pairing, and ChatGPT login state.

## Finish setup in OpenHome

First print the two OpenHome values:

```bash
cd ~/.openhome-gpt-live
bun run openhome:config
```

Then open the [OpenHome Dashboard](https://app.openhome.com) and complete these
steps:

1. Open **Settings → API Keys → Third Party Keys**.
2. Create `openhome_gpt_live_server_url` with the printed HTTPS origin.
3. Create `openhome_gpt_live_bootstrap_token` with the printed enrollment
   token.
4. Link both keys to **OpenHome GPT Live**.
5. Open **My Abilities**. If the installer did not upload the Ability, upload
   `~/.openhome-gpt-live/dist/openhome-gpt-live-ability.zip` as a **Local**
   Ability.
6. Install and enable it on the active Agent.
7. To prevent OpenHome's built-in assistant from also answering ambient speech,
   enable its wake word and change it to a reserved recovery phrase such as
   `openhome fallback seven nine`.
8. Tap **Sync Abilities**, then **Restart Agent**.

## Pair without relying on speaker audio

After the Agent restarts, run this on the host:

```bash
cd ~/.openhome-gpt-live
bun run pairing:code -- --wait=180
```

It prints the eight-digit DevKit code and a one-click setup link. Open that link
on your phone, tap **Pair DevKit**, then use **Open ChatGPT authorization** and
enter the ChatGPT device code shown on the page.

The DevKit may also speak the pairing code, but audio is not required. The host
keeps only a private, short-lived copy for this command: it expires after 15
minutes and is deleted when claimed.

When setup succeeds, the phone page shows the device as live and the ChatGPT
account as connected.

## Choose a voice

The paired `/setup` page contains a **GPT Live Voice** picker. Supported voices
are:

**Arbor, Breeze, Cove, Ember, Juniper, Maple, Sol, Spruce, and Vale.**

Vale is the default for new devices. Saving a different voice restarts only the
Live connection and normally takes about ten seconds. The wake phrase is a
separate setting and remains **Juniper** unless you change the optional
`openhome_gpt_live_wake_phrase` Third Party Key.

## Verify the speaker

Try these in order:

> “Juniper, explain photosynthesis in two sentences.”

> “Juniper, search the web for today’s OpenHome news.”

> “Juniper, create a small web game in my workspace and tell me when it is
> done.”

“Juniper” is required for every new request, including interruptions. While
armed, the offline wake detector runs locally and the worker sends silence to
GPT Live. Real microphone audio is forwarded only after the wake phrase.

The phone page reports the last lane used without storing the spoken request:

| Request | Lane |
| --- | --- |
| Conversation, explanations, date/time | GPT Live |
| Current facts, news, weather, explicit web searches | OpenAI web search |
| Files, code, projects, OpenHome actions, Mac control | Codex |

OpenAI search and Codex work run independently. Codex tasks are serialized,
acknowledged when they start, and announced through GPT Live when they finish.
You can continue ordinary conversation or search while Codex works.

## Codex access modes

The installer defaults to **Workspace only**.

| Mode | Voice-started Codex access |
| --- | --- |
| Workspace only | Read, create, edit, run, and test inside the configured folder. |
| Phone confirmed | Workspace tasks run directly; broader computer actions wait for approval on `/setup`. |
| Full Access | Runs delegated Codex with `danger-full-access` and no approval prompt. The owner assumes the risk. |

Change the mode later with:

```bash
cd ~/.openhome-gpt-live
bun run setup
bun run service:install
```

## Health, updates, and help

```bash
cd ~/.openhome-gpt-live
bun run doctor -- --require-server
bun run service:status
curl http://127.0.0.1:3000/healthz
```

To update, rerun the one-line installer. If the Ability changed, tap **Sync
Abilities** and **Restart Agent** afterward.

- [Troubleshooting by symptom](docs/TROUBLESHOOTING.md)
- [Manual installation and upgrades](docs/MANUAL-INSTALL.md)
- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Security model](SECURITY.md)

## How it works

The OpenHome package combines a Local Ability with a background provider. Its
headless Python worker performs offline wake detection, creates the WebRTC
audio connection, and uses PipeWire's WebRTC acoustic echo canceller for
full-duplex interruption.

The host bridge uses the vendored Login with ChatGPT SDK and the SDK's
app-server GPT Live path. ChatGPT access and refresh material stays on the host
inside the encrypted session store. The host mediates structured Live
handoffs, sends current-information requests to the subscription-backed
Responses endpoint with `web_search`, and sends only local/action requests to
Codex. Search and Codex results return through GPT Live's `appendSpeech` path.
No browser cookies or OpenAI API key are used.

The vendored SDK is pinned to
[`3befb7f`](https://github.com/opencoredev/login-with-chatgpt/commit/3befb7fb625170cb305b116a654c7e2f8672bae4),
the merge commit for the voice PR. See
[`vendor/login-with-chatgpt/UPSTREAM.md`](vendor/login-with-chatgpt/UPSTREAM.md)
for the focused integration patch list and MIT license details.

## Copy/paste prompt for a local coding agent

Paste the prompt below into Codex or another local coding agent running on the
macOS or Linux computer that will host the bridge. It tells the agent to do all
machine work and stop only for browser, account, DNS, or physical-speaker steps.

```text
Set up OpenHome GPT Live end to end on this computer.

Repository:
https://github.com/pkyanam/openhome-gpt-live

Goal:
Install the always-on host bridge, build and upload the OpenHome Local Ability,
connect it through stable HTTPS, retrieve the DevKit pairing code, help me
authorize ChatGPT on my phone, and verify GPT Live conversation, OpenAI web
search, and a local Codex workspace task. Continue autonomously until it works
or a genuinely human-only action is required.

Rules:
- Read README.md, SECURITY.md, docs/STABLE-HTTPS.md,
  docs/MANUAL-INSTALL.md, and docs/TROUBLESHOOTING.md before making changes.
- Preserve an existing .env, data/, pairing/login state, tunnel configuration,
  installed Ability object, and unrelated user changes.
- Never print or commit LWC_SECRET, OPENHOME_API_KEY, ChatGPT tokens/cookies,
  DevKit credentials, tunnel credentials, .env, or data/. Show the bootstrap
  token only when I must paste it into OpenHome.
- Do not install a browser on the DevKit and do not capture ChatGPT web cookies.
  Authorization uses the Login with ChatGPT device-code flow on my phone.
- Require a stable HTTPS origin. A random trycloudflare URL is evaluation-only.
- Default Codex to Workspace only. Ask before Phone confirmed or Full Access;
  Full Access requires an explicit risk acknowledgement.
- Do not weaken HTTPS, account-email binding, origin checks, secret lengths, or
  confirmation boundaries to make setup pass.

Execution:
1. Confirm macOS or Linux and check git, curl, Python 3, Bun, and Codex. Install
   Bun if absent. If Codex is missing or logged out, hand off only that human
   login step and resume afterward.
2. Clone to ~/.openhome-gpt-live, or safely fast-forward the existing checkout.
   Run `bun install --frozen-lockfile` and `bun run check`.
3. Collect only missing values: ChatGPT account email, stable public HTTPS
   origin, Codex workspace, access mode, and optional OpenHome API key. Run
   `bun run setup`; preserve existing generated secrets.
4. Verify the public HTTPS health endpoint and install/restart the host with
   `bun run service:install`. Run `bun run doctor -- --require-server` and fix
   every failure.
5. If OPENHOME_API_KEY is configured, run `bun run upload:ability` to create or
   upgrade OpenHome GPT Live in place. Otherwise point me to
   `dist/openhome-gpt-live-ability.zip`. Never delete a working Ability merely
   to upgrade it.
6. Run `bun run openhome:config` and give me one short numbered list for the
   human-only OpenHome steps: create/link the two exact Third Party Keys,
   install/enable the Local Ability, move the built-in assistant to a reserved
   recovery wake phrase, Sync Abilities, and Restart Agent. Wait for me.
7. Run `bun run pairing:code -- --wait=180`. Give me the one-click setup link
   and pairing code without exposing any other state. If no code appears,
   diagnose Ability installation/configuration instead of asking me to inspect
   raw logs. Have me pair the phone and complete ChatGPT device authorization.
8. On /setup, let me choose one of Arbor, Breeze, Cove, Ember, Juniper, Maple,
   Sol, Spruce, or Vale. Explain that the speaking voice and Juniper wake phrase
   are independent. Wait for Live to reconnect after a change.
9. Verify local and public health, service status, paired-page state, and safe
   DevKit `live_status`. Never read or expose the DevKit config file.
10. Ask me to test:
    - “Juniper, explain photosynthesis in two sentences.”
    - “Juniper, search the web for today’s OpenHome news.” Confirm the page says
      OpenAI web search and Codex remains idle.
    - “Juniper, create a small test file in my workspace and tell me when it is
      done.” Confirm the immediate Codex acknowledgement and final spoken result.
11. If source changes, rerun `bun run check`, upgrade the existing Ability in
    place, then ask me only for Sync Abilities and Restart Agent.

Finish with the installed commit/version, service and public-health status,
Ability ZIP checksum, selected voice, access mode, workspace, and the three
successful spoken tests. Never include secrets or tokens.
```

## Development

```bash
git clone https://github.com/pkyanam/openhome-gpt-live.git
cd openhome-gpt-live
bun install --frozen-lockfile
cp .env.example .env
bun run check
```

`bun run package:ability` produces a reproducible single-root ZIP and SHA-256
checksum in `dist/`. Pull requests are welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md).
