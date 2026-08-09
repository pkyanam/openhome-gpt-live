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
Do not zip the individual files yourself. Run:

```bash
bun run package:ability
unzip -l dist/openhome-gpt-live-ability.zip
```

Every entry must be under `openhome-gpt-live/`, including
`openhome-gpt-live/__init__.py`.

That rooted archive is for creating a new Ability. The build also produces
`dist/openhome-gpt-live-release.zip`, whose files are at the ZIP root because
OpenHome's existing-release editor uses a different archive contract.

## Sync says complete but the speaker still runs old code

Firmware 1.0.8 can keep an existing Local Ability directory instead of
replacing it. Preserve the cloud Ability and pairing, then run on the host:

```bash
cd ~/.openhome-gpt-live
bun run ability:prepare-sync
```

Reconnect the DevKit in OpenHome, tap **Sync Abilities**, and choose **Restart
Agent**. The command moves only the cached `openhome_gpt_live` device folder to
a timestamped backup so Sync can install the current cloud release.

## “Installed Ability does not exist”

The Agent has an installed record pointing at an Ability object that was
removed.

1. Open **My Abilities** and confirm **OpenHome GPT Live** exists.
2. Install that Ability on the active Agent again.
3. Tap **Sync Abilities**, then **Restart Agent**.
4. Enable the newly installed record under **Installed Abilities**.

Sync updates installed Abilities; it does not reinstall one removed from the
Agent. Upload the ZIP again first if the Ability object itself is missing.

## The speaker says configuration is missing

Create and link these exact Third Party Keys:

- `openhome_gpt_live_server_url`
- `openhome_gpt_live_bootstrap_token`

Print the correct values with `bun run openhome:config`. Do not use the
OpenAI/OpenRouter key fields; this project does not consume them.

## I cannot hear or find the pairing code

Speaker audio is optional. After installing/syncing the Ability and restarting
the Agent, run on the host:

```bash
bun run pairing:code -- --wait=180
```

Open the printed one-click URL. If no code appears, the DevKit has not
successfully registered. Check the public health endpoint, Third Party Key
links, Ability installation, Sync Abilities, and Restart Agent in that order.

Codes expire after 15 minutes. Restart the Agent to request another one. The
local inbox is mode 0600 and deletes a code when it is paired or expires.

## The ChatGPT authorization code is missing

The eight-digit OpenHome pairing code comes first. After the browser is paired,
the DevKit requests a separate ChatGPT device code. Keep `/setup` open for a
few seconds; it refreshes automatically. Tap **Open ChatGPT authorization** and
enter the code shown there. Do not paste a bearer token or capture browser
cookies.

## Saying the wake name does nothing

Check in order:

1. `curl http://127.0.0.1:3000/healthz` works on the host.
2. `curl https://your-public-host/healthz` works through the tunnel.
3. **OpenHome GPT Live** is installed and enabled on the active Agent.
4. Both required Third Party Keys are linked to that Ability.
5. You tapped **Sync Abilities** and **Restart Agent** after the latest upload.
6. On firmware 1.0.8, you sent `gpt live diagnostics` once in the dashboard's
   Activity chat to install/start the persistent worker.
7. `/setup` says the DevKit is live and ChatGPT is connected.

Confirm the wake name shown on `/setup`, then say it as part of one request:
“Juniper, explain photosynthesis,” not “Juniper” followed by a long pause.
Juniper is only the default; voice-name presets and custom English names can be
selected on `/setup`.

## Web search says unavailable or starts Codex

Upgrade the host and Ability to **0.2.0 or newer**. The working design uses the
structured app-server handoff: explicit/current queries go to the signed-in
ChatGPT subscription's Responses endpoint with a required `web_search` call,
then the result is spoken through GPT Live. Local Codex is not involved.

After upgrading, update the same Ability object in place, tap **Sync Abilities**,
and **Restart Agent**. On `/setup`, a successful request should show **Last
routed request: OpenAI web search** while Codex remains idle.

## Codex finishes silently or mixes requests

Version 0.2.0 serializes and deduplicates Codex handoffs, acknowledges accepted
work, isolates queued turns, and guarantees a fallback completion announcement.
Upgrade both host and Ability. Confirm `codex --version` and `codex login
status` work for the same host user, then inspect `data/server-error.log`.

## The date or time is stale

Version 0.3.1 and newer uses the app-server's live `currentTime/read` provider.
It never injects a timestamp as a new realtime turn. Confirm the host's system
time and timezone are correct. Clock questions use neither web search nor Codex.

If the speaker recites the date/time after an unrelated request, stop the
DevKit worker, upgrade the host and Ability, Sync Abilities, then restart the
Agent. Older per-wake timestamp injection could outrank the actual request.

## Changing the voice or wake name has no effect

Use the controls on the paired `/setup` page. Saving closes the current Live
session. The page should show `reconnecting` and return to `live` automatically,
normally within a few seconds. Confirm the selected voice and wake name remain
visible.

If it stays `closed`, the DevKit probably still has an Ability older than 0.2.1.
In OpenHome, run **Sync Abilities**, then **Restart Agent** once. The optional
`openhome_gpt_live_voice` and `openhome_gpt_live_wake_phrase` Third Party Keys
are only initial values; the paired browser selections are server-owned and
enforced whenever the DevKit reconnects.

The supported voices are Arbor, Breeze, Cove, Ember, Juniper, Maple, Sol,
Spruce, and Vale. Those names are also wake-name presets, or enter a custom
1–40 character English name. Speaking voice and wake name are independent.

## It worked until a reboot

Run `bun run service:status` on the host. Reinstalling the service is safe:

```bash
bun run service:install
```

The host must remain awake and online. If you used a temporary
`trycloudflare.com` URL, it changed when the tunnel restarted. Create a stable
hostname, rerun setup, update `openhome_gpt_live_server_url`, then sync and
restart the Agent.

The Ability installs a per-user DevKit service where systemd is available, but
normal Live reconnects happen inside the worker and do not depend on systemd.

## The setup page says “closed”

The current WebRTC transport ended. Version 0.2.1 and newer immediately changes
this to `reconnecting` and opens another session. If `closed` persists, sync the
latest Ability, restart the Agent, and inspect the Ability's DevKit log.

## No startup sound

OpenHome does not guarantee a startup sound for this Local Ability. Use
`/setup`, `bun run pairing:code`, and the safe `live_status` diagnostic instead.
A silent boot can still reach the armed state.

## Audio cuts out, crackles, or pauses

The default path expects `parec`, `paplay`, `pactl`, PipeWire-Pulse, and a
working default microphone/speaker. In the Ability editor, invoke the
`audio_devices` DevKit function. When defaults are wrong, set:

- `openhome_gpt_live_capture_device`
- `openhome_gpt_live_playback_device`

Custom ALSA device names bypass the default PipeWire echo-cancel path.

## The speaker hears itself or interruption requires yelling

The official DevKit path uses PipeWire's WebRTC acoustic echo canceller.
Confirm the Ability uses `default` for capture and playback. Do not point
capture directly at an exclusive hardware ALSA source unless diagnosing.

Every interruption also requires the configured wake name. Version 0.3.1
removes permissive phonetic aliases, requires a longer exact detector result,
and does not reopen the ordinary wake gate until assistant playback has ended.
The worker can still cut playback for a real wake-name barge-in. Room acoustics,
volume, and custom Raspberry Pi hardware can affect double talk.

If the speaker starts a response without a person saying the wake name, treat
it as a safety failure: stop the DevKit worker, then upgrade and Sync before
restarting it.

## Both OpenHome and GPT Live answer

OpenHome's public Ability SDK does not expose a provider-registration hook.
Enable the built-in Agent wake word and change it to a reserved recovery phrase,
then restart the Agent. Do not disable the built-in wake word; that can make the
default pipeline answer ambient speech.

## Firmware version

The integration has been exercised on OpenHome firmware 1.0.8. Firmware 1.1.0
is not a prerequisite. On 1.0.8, Local Ability background providers are not
reliably invoked by Agent restart, so use the one-time Activity diagnostic to
bootstrap the enabled systemd worker. Do not reflash solely for this project
when 1.0.8 is otherwise healthy.
