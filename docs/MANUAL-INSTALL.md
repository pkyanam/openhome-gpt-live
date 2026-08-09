# Manual installation and upgrades

Use this when you do not want the one-line installer.

## Install

```bash
git clone https://github.com/pkyanam/openhome-gpt-live.git
cd openhome-gpt-live
bun install --frozen-lockfile
bun run setup -- --help
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
Without an API key, upload `dist/openhome-gpt-live-ability.zip` as a new Local
Ability in the OpenHome dashboard. That archive intentionally has one
top-level directory.

Start the guided OpenHome and pairing handoff with:

```bash
bun run finish
```

It prints both exact keys, then waits while you link them and install and enable
the Ability. Firmware 1.1.1 can synchronize the Ability automatically after
upload. Firmware 1.0.8 asks you to tap **Sync Abilities**, restart the Agent,
and send `gpt live diagnostics` once in Activity. That one-time diagnostic call
installs and starts the persistent systemd worker; it is not a normal
conversation launch phrase.

## Retrieve the pairing code

You do not need working speaker audio or DevKit log access. If you left the
guided command, retrieve the code directly with:

```bash
bun run pairing:code -- --wait=180
```

Open the printed one-click link in any trusted browser, pair the DevKit, and
finish the ChatGPT device-code authorization shown on `/setup`. This control
page is hosted by the Mac/Linux bridge; it is not embedded in OpenHome mobile.
The raw pairing code is
stored only in a short-lived private local inbox and is deleted after claim.

Choose the GPT Live speaking voice and wake name on the same page. The voice
names are offered as wake presets, or enter a custom English name. Saving
restarts the Live connection automatically while preserving pairing and
ChatGPT authorization.

## Upgrade

```bash
cd ~/.openhome-gpt-live
git pull --ff-only
bun install --frozen-lockfile
bun run check
bun run service:install
bun run upload:ability   # when OPENHOME_API_KEY is configured
```

Without an OpenHome API key, upload `dist/openhome-gpt-live-release.zip` in the
existing Ability's release editor and save. OpenHome's update endpoint expects
the files at the ZIP root, unlike its new-Ability upload. Do not delete a
working Ability to upgrade it; an installed record can otherwise point to the
removed object.

After uploading either release format, run:

```bash
bun run ability:prepare-sync
```

On firmware 1.1.1, this runs the device-native capability sync, stages the boot
worker in persistent user state, and restarts GPT Live. On firmware 1.0.8, it
stops GPT Live and renames only its cached Ability folder to a timestamped
backup; reconnect the DevKit, tap **Sync Abilities**, and restart the Agent.
If the older firmware's worker is absent or inactive, send `gpt live
diagnostics` once in Activity. Host-only documentation or UI changes do not
require a speaker sync.

## Change configuration

```bash
bun run setup
bun run service:install
```

If `PUBLIC_BASE_URL` or `DEVKIT_BOOTSTRAP_TOKEN` changes, update the matching
OpenHome Third Party Key, then sync and restart. Changing `LWC_SECRET`
invalidates saved ChatGPT login and browser-pairing state. Back up `.env` and
`data/` together.

The optional `openhome_gpt_live_voice` and
`openhome_gpt_live_wake_phrase` Third Party Keys are initial defaults for a
newly enrolled DevKit. After pairing, use the browser controls; their
server-owned choices survive Ability syncs and Agent restarts.

## Stop or remove

```bash
bun run service:uninstall
```

This removes the host launchd/systemd unit but keeps the project, `.env`, and
state. Disable the Ability and restart the OpenHome Agent to stop the DevKit
worker.

## Non-interactive installation

Automation can use the same installer flags:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | \
  bash -s -- \
    --non-interactive \
    --tunnel existing \
    --public-url https://voice.example.com \
    --email user@example.com \
    --wake-name Maple \
    --workspace /srv/juniper-workspace \
    --access workspace \
    --skip-finish
```

If `CODEX_MAC_CONTROL=full`, also set
`OPENHOME_GPT_LIVE_ACCEPT_FULL_ACCESS=1`. Missing private secrets are generated.
Run `./install.sh --help`, `bun run setup -- --help`, and `bun run tunnel --
--help` for the current mode and flag list.
