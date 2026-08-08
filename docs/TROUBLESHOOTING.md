# Troubleshooting

Start on the host computer:

```bash
cd ~/.openhome-gpt-live
bun run doctor -- --require-server
bun run service:status
```

Then match the symptom below.

## The Ability ZIP is rejected

**“Expected a single top-level directory in ability zipfile”** or
**“`__init__.py` file not found”** means the archive was rebuilt incorrectly.
Do not zip the individual files yourself. Use the release asset or run:

```bash
bun run package:ability
unzip -l dist/openhome-gpt-live-ability.zip
```

Every entry must be under `openhome-gpt-live/`, including
`openhome-gpt-live/__init__.py`.

## “Installed Ability does not exist”

OpenHome still has an installed record that points at an Ability you removed.
Do not keep toggling that stale card.

1. Open **My Abilities** and confirm **OpenHome GPT Live** exists there.
2. Install that Ability on the active Agent again.
3. Tap **Sync Abilities**, then **Restart Agent**.
4. Return to **Installed Abilities** and enable the newly installed record.

If the Ability itself is missing, upload the ZIP again first.

## Sync does not restore an uninstalled Ability

Sync updates Abilities that are installed; it does not reinstall one deleted
from the device/Agent assignment. Reinstall from **My Abilities**, then sync and
restart.

## The speaker says configuration is missing

Both exact Third Party Key names must exist and be linked to the Ability:

- `openhome_gpt_live_server_url`
- `openhome_gpt_live_bootstrap_token`

Print the correct values with `bun run openhome:config`. Do not use the
OpenAI/OpenRouter key fields; this integration does not consume them.

## Saying “Juniper” does nothing

Check in order:

1. `curl http://127.0.0.1:3000/healthz` works on the host.
2. `curl https://your-public-host/healthz` works through the tunnel.
3. **OpenHome GPT Live** is installed and enabled on the active Agent.
4. Both Third Party Keys are linked to that Ability.
5. You tapped **Sync Abilities** and then **Restart Agent** after the last change.
6. The phone `/setup` page says the DevKit is authenticated and ChatGPT is
   connected.

Say the wake phrase as part of the request: “Juniper, tell me the weather,” not
just “Juniper” followed by a long pause.

## It worked until a reboot

On the host, run `bun run service:status`. On the DevKit, the Ability installs a
per-user `openhome-gpt-live.service` when systemd is available. Reinstalling the
host service is safe:

```bash
bun run service:install
```

If you used a temporary `trycloudflare.com` URL, it changed at reboot. Create a
stable tunnel, rerun `bun run setup`, update
`openhome_gpt_live_server_url`, sync, and restart the Agent.

The host computer must also remain awake and online. A closed or sleeping
MacBook pauses the bridge even though launchd still considers the service
installed.

## The setup page says “closed”

“Closed” means the last 30-minute WebRTC transport ended. The DevKit watchdog
should create another session automatically. Wait up to one minute and refresh.
If it remains closed, restart the Agent and inspect the DevKit log in the
Ability editor.

## No startup sound

OpenHome does not guarantee a startup sound for this Local Ability. Use the
phone `/setup` state and `live_status` diagnostics instead. A silent boot can
still reach the armed state.

## Audio cuts out, crackles, or pauses

The default path expects `parec`, `paplay`, `pactl`, PipeWire-Pulse, and a
working default microphone/speaker. In the Ability editor, invoke the
`audio_devices` DevKit function and set these optional Third Party Keys when the
defaults are wrong:

- `openhome_gpt_live_capture_device`
- `openhome_gpt_live_playback_device`

Custom ALSA device names bypass the default PipeWire echo-cancel path.

## Juniper hears itself or interruption requires yelling

The official DevKit default uses PipeWire's WebRTC acoustic echo canceller.
Confirm `pactl`, `parec`, and `paplay` exist and that the Ability is using
`default` for both audio devices. Do not point capture directly at an exclusive
hardware ALSA source unless diagnosing.

Every interruption also requires “Juniper.” The worker mutes playback
immediately after the offline detector hears it, then forwards the replacement
request. Room acoustics, speaker volume, and custom Raspberry Pi hardware can
still affect double-talk performance.

## Both OpenHome and Juniper answer

The public OpenHome SDK does not expose a provider-registration hook. Enable
the built-in Agent wake word and change it to a reserved recovery phrase, then
restart the Agent. Do not disable the built-in wake word; that makes the default
pipeline answer ambient speech.

## Codex starts but the speaker is silent

The bridge should acknowledge the handoff after Codex accepts it and speak the
result when complete. Check `data/server-error.log`, confirm `codex --version`
works for the same host user, and run the doctor. Long tasks keep Live available
for other conversation, but only their final result is spoken.

## Date or time is stale

The DevKit refreshes an authenticated host-clock context on every wake. Confirm
the host computer's time and timezone are correct and that the public bridge is
reachable. Time questions do not use web search or a Codex handoff.

## Firmware version

The integration has been exercised on OpenHome firmware 1.0.8. Firmware 1.1.0
is not a prerequisite. Do not reflash solely for this project when 1.0.8 is
otherwise healthy.
