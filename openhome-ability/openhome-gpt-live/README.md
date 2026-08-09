# OpenHome GPT Live Local Ability

This package makes GPT Live the background speech-to-speech provider for an
OpenHome DevKit. `main.py` is the required interactive diagnostics entrypoint.
`background.py` starts with the Personality session, configures the headless
worker, monitors it, and restarts failed or expired sessions.

PocketSphinx detects the `Juniper` wake phrase locally. While armed, the
WebRTC microphone track contains silence. Real microphone audio is forwarded
only after the wake phrase. The worker re-arms when remote answer audio begins
after the near-end request falls silent, with a timeout fallback for failed
turns. Every new request and interruption requires `Juniper`.

The default official-DevKit path selects the VoiceHAT's useful capture channel
and uses PipeWire WebRTC acoustic echo cancellation. `aiortc` carries audio for
the Login with ChatGPT app-server Realtime session. The DevKit needs no browser,
screen, keyboard, or mouse.

## Required Third Party Keys

- `openhome_gpt_live_server_url` — stable public HTTPS origin of the host.
- `openhome_gpt_live_bootstrap_token` — same value as host
  `DEVKIT_BOOTSTRAP_TOKEN`.

## Optional Third Party Keys

- `openhome_gpt_live_model` — exact entitled Codex model slug; otherwise the
  first discovered model is used.
- `openhome_gpt_live_voice` — initial voice for a newly enrolled device;
  defaults to `vale`. After pairing, use the `/setup` browser picker.
- `openhome_gpt_live_capture_device` — ALSA source, default `default`.
- `openhome_gpt_live_playback_device` — ALSA sink, default `default`.
- `openhome_gpt_live_wake_phrase` — default `juniper`.
- `openhome_gpt_live_awake_timeout_seconds` — safety timeout for a request that
  never completes; default 30 seconds.

Supported GPT Live voices are Arbor, Breeze, Cove, Ember, Juniper, Maple, Sol,
Spruce, and Vale. Speaking voice and wake phrase are independent. Changing the
voice in the browser control page closes the current Live transport; the DevKit
worker reads the new server-owned setting and reconnects in-process without
waiting for OpenHome or systemd to relaunch it.

## First pairing

After registration, the DevKit may announce the setup URL and eight-digit code.
Audio is optional: on the host, `bun run pairing:code -- --wait=180` prints the
same short-lived code and a one-click setup link. Pair a trusted browser there
and complete ChatGPT device authorization. The page is hosted by the Mac/Linux
bridge, not the OpenHome mobile app.

## OpenHome fallback voice

The public Ability SDK does not expose a provider-registration hook, so the
built-in OpenHome STT/TTS pipeline exists in parallel. Enable the built-in Agent
wake word and change it to a reserved recovery phrase such as `openhome fallback
seven nine`. GPT Live continues to use the offline Juniper gate.

The required trigger phrase `gpt live diagnostics` is a one-time firmware-1.0.8
bootstrap and recovery check. Send it from the OpenHome Activity chat after the
first Sync/Agent restart; it installs or starts the persistent worker and
reports status. Normal conversation never uses that trigger.

Disable the Ability and restart the Agent to stop the provider. If default
audio fails, invoke `audio_devices` in the Ability editor and configure the
exact capture/playback device names.
