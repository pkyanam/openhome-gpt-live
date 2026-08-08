# OpenHome GPT Live Background Local Ability

This package makes GPT Live the automatically active speech-to-speech plane for
an OpenHome DevKit. `main.py` supplies the Local Ability's required cloud
entrypoint, while `background.py` starts with the Personality session,
launches the headless DevKit worker, monitors it, and reconnects expired or
failed sessions. The offline `Juniper` wake phrase opens GPT Live; microphone
audio is replaced with silence on the WebRTC connection while armed.

After the first successful configuration, the DevKit installs a per-user
`openhome-gpt-live.service`. It starts GPT Live after a power cycle and restarts
a completed or interrupted Live session automatically.

The default worker captures the VoiceHAT's useful right channel and routes
capture/playback through PipeWire WebRTC acoustic echo cancellation. It uses
`aiortc` for the merged login-with-chatgpt WebRTC protocol. No Chromium, screen,
keyboard, or mouse is required.

Create a **Local** Ability, upload all files, and preserve the registration
marker in `background.py`. The Ability itself stays background-enabled; its
DevKit worker owns wake-phrase gating.

Declare these required Ability API-key fields:

- `openhome_gpt_live_server_url` — public HTTPS origin of the Bun service.
- `openhome_gpt_live_bootstrap_token` — same value as the server's
  `DEVKIT_BOOTSTRAP_TOKEN`.

Optional fields:

- `openhome_gpt_live_model` — exact account model slug; otherwise account
  discovery chooses the first result.
- `openhome_gpt_live_voice` — defaults to `juniper`.
- `openhome_gpt_live_capture_device` — ALSA source, defaults to `default`.
- `openhome_gpt_live_playback_device` — ALSA sink, defaults to `default`.
- `openhome_gpt_live_wake_phrase` — defaults to `juniper`.
- `openhome_gpt_live_awake_timeout_seconds` — 30-second safety timeout for a
  request that never completes.

Say `Juniper` before every request. The worker returns to armed mode immediately
after each completed answer. A mid-answer barge-in remains active long enough
to capture the interrupted replacement request.

OpenHome's public Ability SDK runs Background/Local audio in parallel with its
built-in STT/TTS pipeline; it does not expose a provider registration hook. To
prevent two assistants from answering, enable the Agent's built-in wake word
and set it to a reserved recovery phrase such as `openhome fallback seven nine`.
Save and restart the Agent. GPT Live remains active independently; the reserved
phrase is only for intentionally reaching the fallback Personality.

On first automatic start the DevKit announces the service setup URL and an
eight-digit pairing code. Open the URL on a phone, enter the code, and complete
ChatGPT authorization. The phone remains the approval surface for consequential
OpenHome tools.

If the default audio device fails, invoke `audio_devices` from the Ability
editor and configure the exact ALSA capture/playback names. Disable this Ability
and restart/sync the Agent to stop the GPT Live worker.

The required interactive trigger `gpt live diagnostics` is only a recovery
check. It reads whether the local worker is running and speaks its current
state; normal GPT Live requests always start with the offline wake phrase.
