# Manual installation and upgrades

Use this when you do not want the one-line installer.

## Install

```bash
git clone https://github.com/pkyanam/openhome-gpt-live.git
cd openhome-gpt-live
bun install --frozen-lockfile
bun run setup
bun run check
bun run service:install
```

If you supplied an OpenHome API key during setup:

```bash
bun run upload:ability
```

That command creates **OpenHome GPT Live** when absent and upgrades the same
Ability object when present, preserving its id and linked Third Party Keys.
Without an API key, upload `dist/openhome-gpt-live-ability.zip` as a Local
Ability in the OpenHome dashboard.

Print the exact Third Party Keys with:

```bash
bun run openhome:config
```

Link both keys, install and enable the Ability on the active Agent, tap **Sync
Abilities**, and choose **Restart Agent**.

## Retrieve the pairing code

You do not need working speaker audio or DevKit log access. After the Agent
restarts, run:

```bash
bun run pairing:code -- --wait=180
```

Open the printed one-click link in any trusted browser, pair the DevKit, and
finish the ChatGPT device-code authorization shown on `/setup`. This control
page is hosted by the Mac/Linux bridge; it is not embedded in OpenHome mobile.
The raw pairing code is
stored only in a short-lived private local inbox and is deleted after claim.

Choose the GPT Live speaking voice on the same page. Voice changes restart the
Live connection automatically; the wake phrase is configured separately.

## Upgrade

```bash
cd ~/.openhome-gpt-live
git pull --ff-only
bun install --frozen-lockfile
bun run check
bun run service:install
bun run upload:ability   # when OPENHOME_API_KEY is configured
```

Without an OpenHome API key, upload the rebuilt ZIP in the existing Ability
editor and save. Do not delete a working Ability to upgrade it; an installed
record can otherwise point to the removed object.

After an Ability upgrade, tap **Sync Abilities** and **Restart Agent**. Host-only
documentation or UI changes do not require a speaker sync.

## Change configuration

```bash
bun run setup
bun run service:install
```

If `PUBLIC_BASE_URL` or `DEVKIT_BOOTSTRAP_TOKEN` changes, update the matching
OpenHome Third Party Key, then sync and restart. Changing `LWC_SECRET`
invalidates saved ChatGPT login and browser-pairing state. Back up `.env` and
`data/` together.

The optional `openhome_gpt_live_voice` Third Party Key is only the initial
default for a newly enrolled DevKit. After pairing, use the browser picker; its
server-owned choice survives Ability syncs and Agent restarts.

## Stop or remove

```bash
bun run service:uninstall
```

This removes the host launchd/systemd unit but keeps the project, `.env`, and
state. Disable the Ability and restart the OpenHome Agent to stop the DevKit
worker.

## Non-interactive installation

Automation may pre-set values from `.env.example`:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | \
env OPENHOME_GPT_LIVE_NONINTERACTIVE=1 \
    APP_ALLOWED_CHATGPT_EMAIL=user@example.com \
    PUBLIC_BASE_URL=https://voice.example.com \
    CODEX_WORKSPACE=/srv/juniper-workspace \
    bash
```

If `CODEX_MAC_CONTROL=full`, also set
`OPENHOME_GPT_LIVE_ACCEPT_FULL_ACCESS=1`. Missing private secrets are generated.
