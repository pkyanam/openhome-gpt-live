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

If one browser is already paired, open `/setup` there and choose **Pair another
browser**. Enter the displayed code on the phone, tablet, or second computer.
Browser pairing uses a signed HttpOnly cookie per browser profile; ChatGPT
authorization and device credentials remain server-side, and existing paired
browsers are not signed out.

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

## A Spotify command starts Codex

The sister Ability is optional. Confirm its host reports ready, then set both
`OPENHOME_SPOTIFY_URL` and `OPENHOME_SPOTIFY_TOOL_TOKEN` in GPT Live's host
environment and restart only after an owner-approved maintenance window. Never
copy Spotify OAuth tokens into GPT Live. `/setup` should report the last routed
request as **OpenHome Spotify** while Codex remains idle.

The GPT Live audio guard exempts only Chromium streams with the exact PulseAudio
property `application.id=com.openhome.spotify`. Unmarked Chromium remains under
the existing mute watchdog. Use the sister project's audio diagnostics to
confirm the marker instead of disabling the guard globally.

## An email command starts Codex or AgentMail is unavailable

The AgentMail lane is optional and requires both `AGENTMAIL_API_KEY` and
`AGENTMAIL_INBOX`. Run `bun run agentmail:setup`; it hides the key, validates
the exact selected inbox without enumerating the account, and preserves every
other `.env` value. Prefer an inbox-scoped key with `inbox_read` and
`message_send`, then restart the GPT Live host service.

An explicit request such as “Lara, send an email to person@example.com saying
thank you” should show **Last routed request: AgentMail** on `/setup` while
Codex remains idle. Draft-only requests, inbox reading, replies, attachments,
multiple recipients, or an explicitly named Gmail/Outlook/Mac app are not part
of this first AgentMail lane.

If GPT Live says it could not confirm a send, inspect AgentMail before repeating
the command. The provider idempotency key protects a normalized retry for 24
hours, but checking first avoids turning a differently worded retry into a
second logical message.

## The first wake request is silent but repeating it works

Upgrade the Ability to **0.3.9 or newer**. Version 0.3.8 shortened the retained
wake boundary to avoid capture backpressure, but PocketSphinx can confirm a
short custom name near the end of the combined utterance. That could discard
the prompt before the gate opened.

Version 0.3.9 restores a 500 ms boundary and drains one fresh capture frame into
a bounded delay queue for every frame it forwards. Say the wake name and prompt
naturally as one utterance. A healthy worker log reports 500 ms of buffered
audio; it never logs microphone content.

The speaker does not require manual reactivation after 30 minutes. Version
0.3.9 removes the simultaneous 30-minute host and DevKit timers. Live remains
connected through idle periods and automatically reconnects on an upstream or
long-duration safety close.

## The first request works, then later wake requests receive no answer

Upgrade the host and Ability to **0.3.2 or newer**. Some `/wm` calls remain
nominally connected after a native search while silently refusing later audio
turns. The DevKit now detects one authenticated request with no assistant audio,
marks the session `reconnecting`, and negotiates a fresh call automatically.
Pairing, ChatGPT authorization, voice, and wake-name settings are preserved.

## The speaker talks without anyone saying the wake name

Stop the DevKit worker immediately and mute the firmware Chromium streams. In
versions through 0.3.8, the custom-name detector used a one-answer JSGF grammar.
Ordinary room audio could be forced into that only legal result and falsely
confirm Lara. This can produce both unanswered reconnect loops and actual GPT
Live responses to background audio.

Upgrade to 0.3.10 or newer. The detector now uses PocketSphinx keyphrase
spotting, with a substantially stricter likelihood-ratio threshold for
false-prone one-word names. Assistant playback cannot open a replacement turn
unless the barge-in gate also proves sustained near-end speech above the
measured DevKit echo floor. A second safety layer pauses Live for 30 minutes if
six accepted detections occur inside two minutes. Worker logs include
timestamps and candidate RMS only; they never include microphone audio or
transcripts.

If a request receives no answer, wait roughly twenty seconds for `/setup` to
return to `live`, then say the wake name and request once more. A persistent
named tunnel is recommended when Quick Tunnel logs also show intermittent 502
responses.

## Codex finishes silently, mixes requests, or delays a second task

Upgrade to 0.3.9 or newer. Each request receives an isolated Codex thread and up
to four tasks can run in parallel. The bridge announces acceptance before it
waits for task-thread startup, and the DevKit immediately re-arms the physical
wake gate. A long spoken request or slow Codex launch therefore cannot be
mistaken for a dead GPT Live session. The bridge correlates tools and completion
by thread id and guarantees a fallback completion announcement. Confirm
`codex --version` and `codex login status` work for the same host user, then
inspect `data/server-error.log`.

## A media request opens duplicate tabs or Codex keeps clicking

Upgrade to 0.3.7 or newer. Each physical wake now has one server-enforced route,
so a completed Codex request cannot later escape into OpenAI search or another
Codex task. Media playback is single-flight and allows one
reused or newly opened tab, one selected result, and one playback stream. The
bridge gives Codex only the exact current request, ends the task when Codex
speaks its completion or its tool output confirms playback, blocks an identical
repeated action, and interrupts it after eight actions or 90 seconds. Direct
computer-control tasks have a 20-action and two-minute limit.

If the speaker says native web access is unavailable and then performs the
action anyway, the host is older than 0.3.7 or the existing Live session has not
reconnected. Restart the host service and wait for `/setup` to return to `live`.

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
Version 0.3.4 suppresses only the firmware dashboard's Chromium microphone and
speaker streams while GPT Live owns audio. It leaves GPT Live, PipeWire, device
management, and the dashboard process running. The watchdog reapplies the mute
if a firmware or browser restart recreates those streams. Stopping GPT Live
restores the default Agent streams.

## Firmware version

The integration has been physically exercised on OpenHome firmware 1.0.8 and
1.1.1. On 1.0.8, Local Ability background providers are not reliably invoked by
Agent restart, so use the one-time Activity diagnostic to bootstrap the enabled
systemd worker. Firmware 1.1.1 adds a device-native capability-sync command,
which `bun run ability:prepare-sync` uses automatically.

A firmware replacement may remove the firmware-managed Local Ability directory.
Version 0.3.3 stages the persistent boot worker under
`~/.local/share/openhome-gpt-live/runtime`, so the provider no longer depends on
that replaceable path. Run `bun run upload:ability` followed by
`bun run ability:prepare-sync` to restore or upgrade the cloud Ability after a
firmware change.
