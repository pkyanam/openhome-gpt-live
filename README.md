# OpenHome GPT Live

Turn an OpenHome DevKit into a wake-word GPT Live speaker with OpenAI web
search and optional local Codex tools. Start every request with your chosen
wake name—**“Juniper, …”** by default.

[Explore the project site](https://pkyanam.github.io/openhome-gpt-live/) ·
[Troubleshooting](docs/TROUBLESHOOTING.md) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Security](SECURITY.md)

- GPT Live owns speech, conversation, and general knowledge.
- OpenAI's first-party search handles current information.
- Codex can handle files, projects, applications, and computer actions.
- ChatGPT uses device-code authorization—no API key or cookie capture.
- The DevKit needs no browser, display, keyboard, or mouse.

> [!IMPORTANT]
> This is an independent, self-hosted integration—not an OpenHome or OpenAI
> product. It uses experimental GPT Live support from
> [`login-with-chatgpt` PR #6](https://github.com/opencoredev/login-with-chatgpt/pull/6).
> A private upstream protocol change can require a project update.

## Quick start

Run this on the macOS or Linux computer that will stay online with the speaker:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash
```

The interactive wizard is safe to rerun. It updates clean installations,
preserves `.env`, `data/`, pairing/login state, tunnel credentials, and the
existing cloud Ability id, and pauses instead of overwriting local changes.

It offers four HTTPS choices:

1. **Persistent Cloudflare Tunnel** — recommended when your domain uses
   Cloudflare; creates/reuses a named account tunnel and a user service.
2. **Existing HTTPS URL** — use any stable reverse proxy already forwarding to
   `http://127.0.0.1:3000`.
3. **Quick Tunnel** — a temporary evaluation URL that changes after restart.
4. **Configure later** — prepares the host without starting production.

See every interactive and automation option without installing:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash -s -- --help
```

### Prefer a local agent?

The repository is a Codex-compatible plugin and includes a concise, reusable
skill plus deterministic preflight and status scripts. Give a local coding
agent this small prompt:

```text
Read and follow https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/skills/openhome-gpt-live/SKILL.md.
Set up OpenHome GPT Live on this computer. Do every safe machine step, preserve existing state, and pause only for the human-only account, dashboard, DNS, authorization, or physical-speaker steps named by the skill.
```

That replaces the former page-long agent prompt. After cloning, Codex can load
`$openhome-gpt-live` directly from [`skills/openhome-gpt-live`](skills/openhome-gpt-live).

## What you need

- An onboarded OpenHome DevKit with Local Abilities. Firmware **1.0.8 and
  1.1.1 are physically tested**.
- A ChatGPT subscription with GPT Live access.
- A macOS or Linux host that stays online.
- A stable public HTTPS origin before production use.

Everything else is optional:

| Component | What it adds | Without it |
| --- | --- | --- |
| Codex | Files, projects, apps, and computer actions | GPT Live conversation and OpenAI search still work |
| OpenHome API key | Automatic Ability upload and account tools | Upload the generated ZIP in the dashboard |
| Cloudflare account/domain | Wizard-managed persistent tunnel | Use another HTTPS proxy or configure later |
| Python 3 | Local Ability tests and packaging | Installer can use prebuilt release ZIPs |

The official DevKit is the supported full-duplex target. Custom Raspberry Pi
audio may need manual device selection and may interrupt less reliably.

## The guided handoff

The installer finishes by running:

```bash
cd ~/.openhome-gpt-live
bun run finish
```

This prints the exact two required OpenHome Third Party Keys plus the optional
initial wake-name key, and walks through the only
steps the host cannot perform for you:

1. Link the printed server URL and bootstrap token to **OpenHome GPT Live**.
2. Install and enable the Local Ability. Without API automation, upload
   `dist/openhome-gpt-live-ability.zip`.
3. Run `bun run ability:prepare-sync` after installation. Firmware 1.1.1 then
   synchronizes and restarts GPT Live automatically. Firmware 1.0.8 asks you to
   tap **Sync Abilities**, restart the Agent, and send `gpt live diagnostics`
   once in Activity.
4. Press Enter in the wizard. It retrieves the DevKit pairing code from the
   host—speaker audio and raw log inspection are not required.
5. Open the printed `/setup` link in any trusted browser and complete Login with
   ChatGPT device-code authorization. Choose the speaking voice and wake name
   on that same page.

The browser is a setup/control surface served by this bridge. It can be on the
host, another computer, a phone, or a tablet; it is **not** embedded in the
OpenHome mobile app, and speaker audio never passes through it.

Pairing is per browser profile because the setup session uses a signed,
HttpOnly cookie. ChatGPT and DevKit credentials remain server-side. From any
already paired `/setup` page, choose **Pair another browser** to create a
15-minute code for a phone, tablet, or second computer; existing browsers stay
paired.

## Installer examples

Interactive persistent Cloudflare setup:

```bash
./install.sh --tunnel cloudflare --hostname voice.example.com
```

Existing reverse proxy:

```bash
./install.sh --tunnel existing --public-url https://voice.example.com
```

Agent or unattended host preparation:

```bash
./install.sh \
  --non-interactive \
  --tunnel existing \
  --public-url https://voice.example.com \
  --email user@example.com \
  --wake-name Vale \
  --workspace /srv/juniper \
  --access workspace \
  --skip-finish
```

Pass secrets through hidden prompts or environment variables, never CLI flags.
Full Access additionally requires `OPENHOME_GPT_LIVE_ACCEPT_FULL_ACCESS=1` in
non-interactive mode.

The same controls are available after installation:

```bash
bun run setup -- --help
bun run tunnel -- --help
bun run finish -- --help
```

## Verify the speaker

Try these in order, replacing “Juniper” if you selected another wake name:

> “Juniper, explain photosynthesis in two sentences.”

> “Juniper, search the web for today’s OpenHome news.”

> “Juniper, create a small web game in my workspace and tell me when it is
> done.”

The configured wake name is required for every new request, including
interruptions. The
offline gate runs locally, closes again after every answer, and keeps the same
GPT Live session so conversation context survives.

While GPT Live is running, the Ability mutes only the firmware dashboard's
default Chromium voice input and output. This prevents the stock OpenHome Agent
from talking over GPT Live or waking it with its own speech. Stopping GPT Live
restores those streams.

| Request | Lane |
| --- | --- |
| Conversation, explanations, date/time | GPT Live |
| Current facts, news, weather, web searches | OpenAI web search |
| Files, code, projects, OpenHome actions, computer and media-app control | Codex |

Search and Codex work run independently. Each Codex request starts immediately
in its own isolated thread, up to four at once. GPT Live acknowledges each start
and announces each result without blocking conversation or OpenAI web search.
Browser media is intentionally single-flight: one request may reuse or open one
tab and start one stream. Codex chooses the tools required by the user's exact
request. The bridge ends the task when Codex reports completion or when its own
tool result confirms playback, blocks an exact repeated action, and enforces
bounded action counts and hard deadlines.

Each physical wake opens one routing transaction. Its first handoff has one
owner, so a Codex task cannot later become a search or another Codex task even
if GPT Live rephrases it. Repeated fallback handoffs stay silent, and the
configured wake name is removed before routing. Commands such as “play a song on YouTube,” “control
Spotify,” or “pause Apple Music” always use the media lane rather than the web
search fallback.

## Voices, wake names, and access

Choose Arbor, Breeze, Cove, Ember, Juniper, Maple, Sol, Spruce, or Vale on the
paired `/setup` page. Vale is the new-device voice default. Choose any of those
names as a wake preset or enter a custom English wake name. Juniper is the
default. Saving either setting reconnects GPT Live automatically while keeping
the device pairing and ChatGPT authorization. The new wake name is then
required before every request and interruption.

For unattended initial setup, pass `--wake-name NAME`. After pairing, the
server-owned `/setup` selection takes precedence and survives Ability syncs and
Agent restarts.

Codex defaults to **Workspace only**:

| Mode | Voice-started access |
| --- | --- |
| Workspace only | Work inside the configured folder |
| Browser confirmed | Broader computer actions wait for approval on `/setup` |
| Full Access | Approval-free `danger-full-access`; owner assumes the risk |

Run `bun run setup` and `bun run service:install` to change modes later.

## Update, health, and recovery

Rerun the one-line installer to update or resume. Useful direct checks:

```bash
cd ~/.openhome-gpt-live
bun run doctor -- --require-server
bun run service:status
bun run tunnel -- status
curl http://127.0.0.1:3000/healthz
```

For an Ability code update:

```bash
bun run ability:prepare-sync
```

On firmware 1.1.1, this uses OpenHome's device-native capability sync and
restarts GPT Live automatically. Firmware 1.0.8 falls back to archiving the
cached Ability; reconnect the DevKit, tap **Sync Abilities**, and restart the
Agent. Neither path deletes the cloud Ability, pairing, ChatGPT authorization,
or host state.

- [Troubleshooting by symptom](docs/TROUBLESHOOTING.md)
- [Manual setup and upgrades](docs/MANUAL-INSTALL.md)
- [Stable HTTPS details](docs/STABLE-HTTPS.md)
- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Security model](SECURITY.md)

## How it works

The OpenHome package combines a Local Ability with a background provider. Its
headless Python worker performs offline wake detection, WebRTC audio, and
PipeWire acoustic echo cancellation.

The host bridge uses the vendored Login with ChatGPT SDK's app-server GPT Live
path. ChatGPT access and refresh material stays encrypted on the host. The host
routes current-information requests to subscription-backed `web_search`, sends
local/action requests to Codex, and returns results through GPT Live speech. No
browser cookies or OpenAI API key are used.

The SDK is pinned to the voice-PR merge commit
[`3befb7f`](https://github.com/opencoredev/login-with-chatgpt/commit/3befb7fb625170cb305b116a654c7e2f8672bae4).
See [`vendor/login-with-chatgpt/UPSTREAM.md`](vendor/login-with-chatgpt/UPSTREAM.md)
for the integration patch list and MIT license details.

## Development

```bash
git clone https://github.com/pkyanam/openhome-gpt-live.git
cd openhome-gpt-live
bun install --frozen-lockfile
bun run check
```

`bun run package:ability` produces both OpenHome ZIP formats and a SHA-256
checksum in `dist/`. Pull requests are welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md).
