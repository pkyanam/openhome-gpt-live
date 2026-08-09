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

## Saying “Juniper” does nothing

Check in order:

1. `curl http://127.0.0.1:3000/healthz` works on the host.
2. `curl https://your-public-host/healthz` works through the tunnel.
3. **OpenHome GPT Live** is installed and enabled on the active Agent.
4. Both required Third Party Keys are linked to that Ability.
5. You tapped **Sync Abilities** and **Restart Agent** after the latest upload.
6. On firmware 1.0.8, you sent `gpt live diagnostics` once in the dashboard's
   Activity chat to install/start the persistent worker.
7. `/setup` says the DevKit is live and ChatGPT is connected.

Say the wake phrase as part of one request: “Juniper, explain photosynthesis,”
not “Juniper” followed by a long pause.

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

The DevKit refreshes an authenticated host-clock context before every wake
request, and the app-server answers clock reads from the host clock. Confirm the
host's system time and timezone are correct. Clock questions use neither web
search nor Codex.

## Changing the voice has no effect

Use the picker on the paired `/setup` page. Saving closes the current Live
session. The page should show `reconnecting` and return to `live` automatically,
normally within a few seconds. Confirm the selected voice remains visible.

If it stays `closed`, the DevKit probably still has an Ability older than 0.2.1.
In OpenHome, run **Sync Abilities**, then **Restart Agent** once. The optional
`openhome_gpt_live_voice` Third Party Key is only an initial value; the paired
browser selection is server-owned and is enforced on every Live negotiation.

The supported voices are Arbor, Breeze, Cove, Ember, Juniper, Maple, Sol,
Spruce, and Vale. Voice and wake phrase are independent.

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

## Juniper hears itself or interruption requires yelling

The official DevKit path uses PipeWire's WebRTC acoustic echo canceller.
Confirm the Ability uses `default` for capture and playback. Do not point
capture directly at an exclusive hardware ALSA source unless diagnosing.

Every interruption also requires “Juniper.” The worker cuts playback when its
offline detector hears the phrase, then forwards the replacement request. Room
acoustics, volume, and custom Raspberry Pi hardware can still affect double
talk.

## Both OpenHome and Juniper answer

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
