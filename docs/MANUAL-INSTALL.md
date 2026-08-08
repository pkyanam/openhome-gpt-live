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

If `OPENHOME_API_KEY` was supplied during setup:

```bash
bun run upload:ability
```

The command creates the Ability when it is absent and upgrades the existing
Ability in place when it is already present. It preserves the existing Ability
id and linked Third Party Keys.

Otherwise upload `dist/openhome-gpt-live-ability.zip` in the OpenHome dashboard
as a Local Ability. Complete the [OpenHome checklist](../README.md#finish-in-openhome).

## Upgrade

```bash
cd ~/.openhome-gpt-live
git pull --ff-only
bun install --frozen-lockfile
bun run check
bun run service:install
```

Upload the new ZIP in the existing Ability editor, save, tap **Sync Abilities**,
and restart the Agent. Avoid deleting a working Ability just to upgrade it;
OpenHome installed records can otherwise point at the removed object.

The installer command performs the same safe host-side upgrade automatically.

## Change configuration

```bash
bun run setup
bun run service:install
```

If the public URL or bootstrap token changed, update the matching Third Party
Keys, sync, and restart the Agent. Changing `LWC_SECRET` invalidates saved
ChatGPT login and pairing state. Back up `.env` together with `data/`.

## Stop or remove the host service

```bash
bun run service:uninstall
```

This removes only the launchd/systemd unit. It keeps the project, `.env`, and
paired-device/login data. Disable the OpenHome Ability and restart the Agent to
stop the DevKit worker.

## Non-interactive installation

Automation may pre-set the documented `.env.example` variables and run:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | \
env OPENHOME_GPT_LIVE_NONINTERACTIVE=1 \
    APP_ALLOWED_CHATGPT_EMAIL=user@example.com \
    PUBLIC_BASE_URL=https://voice.example.com \
    CODEX_WORKSPACE=/srv/juniper-workspace \
    bash
```

If `CODEX_MAC_CONTROL=full`, also set
`OPENHOME_GPT_LIVE_ACCEPT_FULL_ACCESS=1`. Secrets are generated when they are
not supplied.
