# Architecture

```text
OpenHome DevKit
  offline wake word + microphone + speaker
          │ authenticated WebRTC signaling and audio
          ▼
Long-lived Bun bridge on the owner's computer
  Login with ChatGPT session store
  device enrollment and phone pairing
  allowlisted OpenHome tools
          │ native GPT Live + handoff requests
          ▼
ChatGPT subscription / Codex app-server
          │ scoped workspace or owner-selected host access
          ▼
Files, tests, OpenHome account actions, and spoken results

Phone /setup page
  ChatGPT device authorization + consequential-action approvals
```

## DevKit plane

The uploaded archive has exactly one root directory and contains the required
`__init__.py`, `main.py`, `background.py`, `devkit_functions.py`,
`requirements.txt`, and README.

`background.py` starts automatically with the OpenHome Personality session and
monitors the device worker. `devkit_functions.py` installs a persistent user
service when systemd is present, creates the WebRTC connection with `aiortc`,
and handles audio. PocketSphinx hears the wake phrase locally. While armed, the
WebRTC input track is silence; after “Juniper,” real microphone frames are
forwarded until the response completes.

The default official-DevKit path creates a PipeWire-Pulse
`module-echo-cancel` source/sink, sends the cleaned microphone channel to GPT
Live, and plays returned audio through the paired virtual sink. Barge-in first
mutes local playback and sends GPT Live's stop-speaking action.

## Host plane

The Bun process must be long lived; request-isolated serverless functions
cannot hold the Codex app-server subprocess or event stream. It stores encrypted
Login with ChatGPT sessions and hashed/opaque device credentials in `data/`.
The DevKit never receives ChatGPT bearer tokens or the OpenHome API key.

The bridge binds a device to a phone pairing cookie. The phone completes
ChatGPT's device authorization and displays pending consequential actions.
Each native Live session is bound to the authenticated login session.

## Tool plane

GPT Live handles speech, ordinary conversation, current web search, and general
knowledge natively. Requests needing files or host actions become Codex
handoffs. The bridge supplies server-owned tool schemas; neither the browser
nor the DevKit can inject tools.

OpenHome mutations use a prepare/review/confirm flow. Workspace-only Codex runs
in `workspace-write`. Phone-confirmed host tasks start a separate
`danger-full-access` execution only after approval. Full Access configures the
delegated realtime thread itself as `danger-full-access` with approval policy
`never`.

## Lifecycle

- Host launchd/systemd restarts the Bun bridge after failure or reboot.
- DevKit systemd/watchdog restarts its worker after failure or reboot.
- GPT Live transports rotate after 30 minutes and reconnect automatically.
- A fresh authenticated host clock is injected for each wake request.
- Disabling the Ability and restarting the Agent stops the provider.
