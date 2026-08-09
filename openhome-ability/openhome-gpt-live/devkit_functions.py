"""DevKit-side headless GPT Live client for the OpenHome Local Ability."""

import array
import asyncio
from collections import deque
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse

import httpx

try:
    from devkit_utils.devkit_logging import web_logger as log
except ImportError:  # Enables local protocol tests outside OpenHome OS.
    import logging
    logging.basicConfig(level=logging.INFO)
    log = logging.getLogger("openhome_gpt_live")


STATE_DIR = Path(
    os.environ.get(
        "OPENHOME_GPT_LIVE_STATE_DIR",
        str(Path.home() / ".local" / "share" / "openhome-gpt-live"),
    )
)
CONFIG_FILE = STATE_DIR / "config.json"
STATUS_FILE = STATE_DIR / "status.json"
PID_FILE = STATE_DIR / "worker.pid"
WORKER_LOG_FILE = STATE_DIR / "worker.log"
SERVICE_NAME = "openhome-gpt-live.service"
SERVICE_FILE = Path.home() / ".config" / "systemd" / "user" / SERVICE_NAME
AUDIO_RATE = 48_000
AUDIO_SAMPLES = 960
AUDIO_BYTES = AUDIO_SAMPLES * 2
AEC_CHANNELS = 2
AEC_CAPTURE_CHANNEL = 1
AEC_SOURCE = "openhome_gpt_live_aec"
AEC_SINK = "openhome_gpt_live_aec_sink"
DEFAULT_WAKE_PHRASE = "juniper"
DEFAULT_VOICE = "vale"
SUPPORTED_VOICES = {
    "arbor", "breeze", "cove", "ember", "juniper",
    "maple", "sol", "spruce", "vale",
}
DEFAULT_ACTIVE_IDLE_SECONDS = 30
RECONNECT_BASE_SECONDS = 1.0
RECONNECT_MAX_SECONDS = 30.0
WAKE_PREROLL_FRAMES = 25
WAKE_GRAMMAR_SCORE_THRESHOLD = 0.80
WAKE_CONFIRM_FRAMES = 5
WAKE_SILENCE_RMS = 20.0
WAKE_SILENCE_FRAMES = 25
WAKE_INTERRUPT_GUARD_SECONDS = 1.0
PLAYBACK_AUDIBLE_RMS = 20.0
PLAYBACK_UTTERANCE_GAP_SECONDS = 0.6
PLAYBACK_INTERRUPT_CUTOFF_SECONDS = 1.2
REQUEST_SPEECH_RMS = 40.0
REQUEST_END_SILENCE_SECONDS = 0.8
GPT_LIVE_READY_STATES = {"idle", "connected", "listening", "listening_intently"}


def configure_and_start(
    server_url,
    bootstrap_token,
    preferred_model="",
    voice=DEFAULT_VOICE,
    capture_device="default",
    playback_device="default",
    wake_phrase=DEFAULT_WAKE_PHRASE,
    active_idle_seconds=str(DEFAULT_ACTIVE_IDLE_SECONDS),
):
    """Register, start device-code auth, and launch the detached audio client."""
    try:
        server_url = _validate_server_url(server_url)
        bootstrap_token = str(bootstrap_token).strip()
        if len(bootstrap_token) < 32:
            raise ValueError("The DevKit bootstrap token must contain at least 32 characters.")
        _require_audio_commands()
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        existing = _read_json(CONFIG_FILE, default={})
        requested_voice = _validate_voice(voice)
        requested_wake_phrase = _validate_wake_phrase(wake_phrase)
        request_body = {
            "name": "OpenHome DevKit",
            "voice": requested_voice,
            "wakePhrase": requested_wake_phrase,
        }
        if (
            existing.get("server_url") == server_url
            and existing.get("device_id")
            and existing.get("device_token")
        ):
            request_body.update({
                "deviceId": existing["device_id"],
                "deviceToken": existing["device_token"],
            })

        with httpx.Client(timeout=30.0, follow_redirects=False) as client:
            response = _register_device(client, server_url, bootstrap_token, request_body)
            if response.status_code == 401 and "deviceId" in request_body:
                log.warning("Stored DevKit registration was rejected; registering this device again")
                response = _register_device(
                    client,
                    server_url,
                    bootstrap_token,
                    {
                        "name": "OpenHome DevKit",
                        "voice": requested_voice,
                        "wakePhrase": requested_wake_phrase,
                    },
                )
            response.raise_for_status()
            registration = response.json()
            registered_session = registration.get("session", {})
            configured_voice = _validate_voice(
                registered_session.get("voice") or requested_voice
            )
            configured_wake_phrase = _validate_wake_phrase(
                registered_session.get("wakePhrase") or requested_wake_phrase
            )
            config = {
                "server_url": server_url,
                "device_id": registration["deviceId"],
                "device_token": registration["deviceToken"],
                "setup_url": registration["setupUrl"],
                "preferred_model": str(preferred_model).strip(),
                "voice": configured_voice,
                "capture_device": str(capture_device).strip() or "default",
                "playback_device": str(playback_device).strip() or "default",
                "wake_phrase": configured_wake_phrase,
                "active_idle_seconds": _validate_active_idle_seconds(active_idle_seconds),
                "max_session_seconds": 30 * 60,
                **({
                    "pairing_code": registration["pairingCode"],
                    "pairing_issued_at": time.time(),
                } if registration.get("pairingCode") else {}),
            }
            _write_private_json(CONFIG_FILE, config)
            session = _device_request_sync(client, config, "GET", "/session")
            login = session
            if session.get("status") != "authenticated":
                login = _device_request_sync(client, config, "POST", "/login")

        started = _ensure_worker_started()
        _print_payload({
            "success": True,
            "started": started,
            "setup_url": registration["setupUrl"],
            "pairing_code": registration.get("pairingCode"),
            "login_status": login.get("status", "unknown"),
            "user_code": login.get("userCode"),
            "verification_url": login.get("verificationUrl"),
            "spoken_response": _setup_spoken_response(registration, login),
            "error": None,
        })
    except Exception as error:
        log.exception("configure_and_start failed")
        _write_status("error", message=str(error))
        _print_payload({
            "success": False,
            "spoken_response": "I couldn't start GPT Live on the DevKit.",
            "error": {"code": "start_failed", "message": str(error)},
        })


def stop_live():
    """Stop only a worker process that matches this Ability's command line."""
    try:
        service_was_active = _disable_boot_service()
        pid = _read_worker_pid()
        if not pid or not _is_our_worker(pid):
            PID_FILE.unlink(missing_ok=True)
            _write_status("stopped", message="No live worker was running.")
            _print_payload({
                "success": True,
                "stopped": service_was_active,
                "spoken_response": (
                    "GPT Live is stopped."
                    if service_was_active
                    else "GPT Live was not running."
                ),
                "error": None,
            })
            return
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and _is_our_worker(pid):
            time.sleep(0.2)
        if _is_our_worker(pid):
            raise RuntimeError("The GPT Live worker did not stop in time.")
        PID_FILE.unlink(missing_ok=True)
        _write_status("stopped", message="Stopped by the user.")
        _print_payload({
            "success": True,
            "stopped": True,
            "spoken_response": "GPT Live is stopped.",
            "error": None,
        })
    except Exception as error:
        log.exception("stop_live failed")
        _print_payload({
            "success": False,
            "spoken_response": "I couldn't stop GPT Live cleanly.",
            "error": {"code": "stop_failed", "message": str(error)},
        })


def live_status():
    status = _read_json(STATUS_FILE, default={"state": "stopped"})
    pid = _read_worker_pid()
    status["worker_running"] = bool(pid and _is_our_worker(pid))
    config = _read_json(CONFIG_FILE, default={})
    if config.get("setup_url"):
        status["setup_url"] = config["setup_url"]
    pairing_issued_at = config.get("pairing_issued_at")
    if (
        config.get("pairing_code")
        and isinstance(pairing_issued_at, (int, float))
        and time.time() - pairing_issued_at < 15 * 60
    ):
        status["pairing_code"] = config["pairing_code"]
    _print_payload({"success": True, "status": status, "error": None})


def audio_devices():
    """Return ALSA capture/playback names for troubleshooting in DevKit logs."""
    try:
        capture = subprocess.run(
            ["arecord", "-L"], capture_output=True, text=True, timeout=10, check=False
        ).stdout[:20_000]
        playback = subprocess.run(
            ["aplay", "-L"], capture_output=True, text=True, timeout=10, check=False
        ).stdout[:20_000]
        _print_payload({"success": True, "capture": capture, "playback": playback, "error": None})
    except Exception as error:
        _print_payload({"success": False, "error": {"code": "audio_probe_failed", "message": str(error)}})


def _worker():
    """Detached entry point. Output goes to the private worker log, not stdout capture."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    os.chmod(PID_FILE, 0o600)
    try:
        asyncio.run(_run_worker())
    except Exception as error:
        log.exception("headless GPT Live worker failed")
        _write_status("error", message=str(error))
    finally:
        PID_FILE.unlink(missing_ok=True)


async def _run_worker():
    config = _read_json(CONFIG_FILE)
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(signum, stop_event.set)
        except NotImplementedError:
            signal.signal(signum, lambda *_: loop.call_soon_threadsafe(stop_event.set))

    headers = {"Authorization": f"Bearer {config['device_token']}"}
    async with httpx.AsyncClient(
        base_url=config["server_url"],
        headers=headers,
        timeout=httpx.Timeout(45.0, read=None),
        follow_redirects=False,
    ) as client:
        await _run_reconnecting_worker(client, config, stop_event)


async def _run_reconnecting_worker(client, config, stop_event):
    """Keep Live connected without relying on OpenHome or systemd to respawn us."""
    retry_seconds = RECONNECT_BASE_SECONDS
    while not stop_event.is_set():
        model = None
        connected_at = None
        try:
            session = await _wait_for_chatgpt_auth(client, config, stop_event)
            if stop_event.is_set():
                break
            await _sync_device_settings(client, config)
            models_response = await client.get(_device_path(config, "/models"))
            models_response.raise_for_status()
            models = models_response.json().get("models", [])
            model = _choose_model(models, config.get("preferred_model", ""))
            _write_status(
                "connecting",
                message="Opening native GPT Live WebRTC.",
                model=model,
                voice=config.get("voice", DEFAULT_VOICE),
                account=session.get("user", {}).get("email"),
            )
            connected_at = time.monotonic()
            await _run_live_session(client, config, model, stop_event)
            if stop_event.is_set():
                break
            lived_seconds = time.monotonic() - connected_at
            retry_seconds = (
                RECONNECT_BASE_SECONDS
                if lived_seconds >= 30.0
                else min(RECONNECT_MAX_SECONDS, max(2.0, retry_seconds * 2.0))
            )
            log.info("GPT Live session ended; reconnecting in %.1f seconds", retry_seconds)
        except Exception as error:
            if stop_event.is_set():
                break
            log.warning("GPT Live connection failed; retrying: %s", error)
            retry_seconds = min(
                RECONNECT_MAX_SECONDS,
                max(2.0, retry_seconds * 2.0),
            )
        _write_status(
            "reconnecting",
            message=f"GPT Live is reconnecting in {retry_seconds:g} seconds.",
            model=model,
            voice=config.get("voice", DEFAULT_VOICE),
        )
        await _wait_or_stop(stop_event, retry_seconds)

    _write_status("stopped", message="Stopped by the user.")


async def _wait_for_chatgpt_auth(client, config, stop_event):
    session_response = await client.get(_device_path(config, "/session"))
    session_response.raise_for_status()
    session = session_response.json()
    if session.get("status") == "authenticated":
        return session
    login_response = await client.post(_device_path(config, "/login"))
    login_response.raise_for_status()
    login = login_response.json()
    deadline = time.monotonic() + 15 * 60
    while not stop_event.is_set() and time.monotonic() < deadline:
        _write_status(
            "awaiting_chatgpt_auth",
            message="Authorize ChatGPT from the paired browser control page.",
            user_code=login.get("userCode"),
            verification_url=login.get("verificationUrl"),
        )
        await _wait_or_stop(stop_event, max(2, int(login.get("interval", 5))))
        if stop_event.is_set():
            break
        status_response = await client.get(_device_path(config, "/status"))
        status_response.raise_for_status()
        login = status_response.json()
        if login.get("status") == "authenticated":
            return login
        if login.get("status") in ("expired", "error"):
            raise RuntimeError(f"ChatGPT authorization ended with status {login.get('status')}.")
    if stop_event.is_set():
        return {}
    raise TimeoutError("ChatGPT authorization was not completed within fifteen minutes.")


async def _sync_device_settings(client, config):
    """Apply server-owned browser settings before negotiating a new Live call."""
    response = await client.get(_device_settings_path(config))
    response.raise_for_status()
    settings = response.json()
    configured_voice = _validate_voice(
        settings.get("voice") or config.get("voice", DEFAULT_VOICE)
    )
    configured_wake_phrase = _validate_wake_phrase(
        settings.get("wakePhrase") or config.get("wake_phrase", DEFAULT_WAKE_PHRASE)
    )
    if (
        configured_voice != config.get("voice")
        or configured_wake_phrase != config.get("wake_phrase")
    ):
        config["voice"] = configured_voice
        config["wake_phrase"] = configured_wake_phrase
        _write_private_json(CONFIG_FILE, config)
    return config


async def _run_live_session(client, config, model, stop_event):
    try:
        from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
        from av import AudioFrame, AudioResampler
    except ImportError as error:
        raise RuntimeError("aiortc and PyAV were not installed on the DevKit.") from error

    _ensure_echo_cancel()
    _set_playback_muted(False)
    remote_state = {
        "value": "connecting",
        "changed_at": time.monotonic(),
        "hot_frames": 0,
        "last_interrupt": 0.0,
    }
    wake_state = {
        "active": False,
        "assistant_response_seen": False,
        "last_activity": 0.0,
        "last_wake": 0.0,
        "last_user_speech": 0.0,
        "phrase": config.get("wake_phrase", DEFAULT_WAKE_PHRASE),
        "idle_seconds": int(config.get("active_idle_seconds", DEFAULT_ACTIVE_IDLE_SECONDS)),
    }
    playback_error = {"value": None}
    playback_control = {
        "cutoff": False,
        "cutoff_until": 0.0,
        "barge_in": False,
        "muted": False,
        "mute_output": _set_playback_muted,
        "started_at": 0.0,
        "last_frame_at": 0.0,
        "last_audible_at": 0.0,
        "playing_until": 0.0,
    }
    data_channel_holder = {"channel": None}
    seen_data_event_types = set()

    class AlsaInputTrack(MediaStreamTrack):
        kind = "audio"

        def __init__(self, device):
            super().__init__()
            self._device = device
            self._pts = 0
            self._capture_failures = 0
            self._wake_detector = WakePhraseDetector(wake_state["phrase"])
            self._preroll = deque(maxlen=WAKE_PREROLL_FRAMES)
            self._pending = deque()
            self._process = _open_capture_process(device)
            if self._process.stdout is None:
                raise RuntimeError("Could not open the microphone stream.")

        def arm_for_next_request(self, reason):
            """Close only the microphone gate; keep the GPT Live session alive."""
            was_active = _reset_wake_gate(
                wake_state,
                playback_control,
                self._pending,
                self._preroll,
                self._wake_detector,
            )
            if was_active:
                log.info("GPT Live microphone re-armed after %s", reason)
            return was_active

        async def recv(self):
            if self._pending:
                data = self._pending.popleft()
            else:
                capture_bytes = AUDIO_BYTES * AEC_CHANNELS if self._device == "default" else AUDIO_BYTES
                captured = await asyncio.to_thread(
                    _read_exact, self._process.stdout, capture_bytes
                )
                if len(captured) != capture_bytes:
                    self._capture_failures += 1
                    detail = _capture_process_error(self._process)
                    log.warning(
                        "GPT Live microphone stream ended; reopening it (%s/3)%s",
                        self._capture_failures,
                        f": {detail}" if detail else ".",
                    )
                    _terminate_capture_process(self._process)
                    if self._capture_failures >= 3:
                        raise RuntimeError("The microphone stream repeatedly ended unexpectedly.")
                    if self._device == "default":
                        _ensure_echo_cancel()
                    self._process = _open_capture_process(self._device)
                    await asyncio.sleep(0.2)
                    captured = bytes(capture_bytes)
                else:
                    self._capture_failures = 0
                data = _select_capture_audio(captured, self._device)

                if not wake_state["active"]:
                    self._preroll.append(data)
                    wake_detected = self._wake_detector.process(data)
                    now = time.monotonic()
                    wake_rms = _pcm_rms(data) if wake_detected else 0.0
                    if wake_detected and not _wake_allowed_during_playback(
                        wake_rms,
                        remote_state,
                        playback_control,
                        now,
                    ):
                        log.info(
                            "Ignored likely speaker-echo wake at %.1f RMS while GPT Live was talking",
                            wake_rms,
                        )
                        data = bytes(AUDIO_BYTES)
                    elif wake_detected:
                        wake_state["active"] = True
                        wake_state["assistant_response_seen"] = False
                        wake_state["last_activity"] = now
                        wake_state["last_wake"] = now
                        wake_state["last_user_speech"] = now
                        self._pending.extend(self._preroll)
                        self._preroll.clear()
                        data = self._pending.popleft()
                        log.info("GPT Live wake phrase detected: %s", wake_state["phrase"])
                        _maybe_interrupt(
                            data,
                            remote_state,
                            data_channel_holder["channel"],
                            playback_control,
                            wake_word=True,
                        )
                        _write_status(
                            "live",
                            message=f"{wake_state['phrase'].title()} heard. GPT Live is listening.",
                            model=model,
                            voice=config.get("voice", DEFAULT_VOICE),
                            wake_phrase=wake_state["phrase"],
                        )
                    else:
                        data = bytes(AUDIO_BYTES)
                elif _should_return_to_wake_mode(wake_state, remote_state):
                    self.arm_for_next_request("the request timeout")
                    _write_armed_status(config, model, wake_state["phrase"])
                    data = bytes(AUDIO_BYTES)
                else:
                    now = time.monotonic()
                    if _pcm_rms(data) >= REQUEST_SPEECH_RMS:
                        wake_state["last_user_speech"] = now
                    if _should_arm_after_response_audio(
                        wake_state,
                        playback_control,
                        now,
                    ):
                        self.arm_for_next_request("the assistant response finished")
                        _write_armed_status(config, model, wake_state["phrase"])
                        data = bytes(AUDIO_BYTES)
                    else:
                        output_is_playing = _output_is_playing(
                            remote_state,
                            playback_control,
                            now,
                        )
                        wake_interrupt = False
                        if (
                            output_is_playing
                            and now - wake_state["last_wake"] >= WAKE_INTERRUPT_GUARD_SECONDS
                            and now - remote_state["changed_at"] >= WAKE_INTERRUPT_GUARD_SECONDS
                            and self._wake_detector.process(data)
                        ):
                            wake_interrupt = True
                            wake_state["last_wake"] = now
                        _maybe_interrupt(
                            data,
                            remote_state,
                            data_channel_holder["channel"],
                            playback_control,
                            wake_word=wake_interrupt,
                        )
                        if wake_interrupt:
                            wake_state["last_activity"] = now
            frame = AudioFrame(format="s16", layout="mono", samples=AUDIO_SAMPLES)
            frame.planes[0].update(data)
            frame.sample_rate = AUDIO_RATE
            frame.pts = self._pts
            frame.time_base = Fraction(1, AUDIO_RATE)
            self._pts += AUDIO_SAMPLES
            return frame

        def stop(self):
            _terminate_capture_process(self._process)
            super().stop()

    pc = RTCPeerConnection()
    input_track = AlsaInputTrack(config.get("capture_device", "default"))
    pc.addTrack(input_track)
    pc.addTransceiver("video", direction="sendonly")
    # Match login-with-chatgpt's merged browser transport exactly: the empty,
    # pre-negotiated data channel at dcid=0 carries nested JSON events.
    data_channel = pc.createDataChannel("", negotiated=True, id=0, ordered=True)
    data_channel_holder["channel"] = data_channel
    playback_tasks = set()
    connection_closed = asyncio.Event()
    data_channel_open = asyncio.Event()

    @data_channel.on("open")
    def on_data_open():
        data_channel_open.set()
        _write_armed_status(config, model, wake_state["phrase"])

    @data_channel.on("message")
    def on_data_message(message):
        event = decode_realtime_event(message)
        if not event:
            return
        event_type = event.get("type")
        if event_type not in seen_data_event_types:
            seen_data_event_types.add(event_type)
            log.info("GPT Live received data event: %s", event_type)
        if event_type == "state_update":
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else event
            state = payload.get("new_state")
            if isinstance(state, str):
                previous_state = remote_state["value"]
                remote_state["value"] = state
                if state != previous_state:
                    remote_state["changed_at"] = time.monotonic()
                    log.info("GPT Live state changed: %s -> %s", previous_state, state)
                    if state == "speaking":
                        wake_state["assistant_response_seen"] = True
                        # Discard the user's initial wake phrase and request
                        # audio before listening for a second Juniper used as
                        # barge-in. Without this reset, the very-low-threshold
                        # decoder can finish its old hypothesis after playback
                        # begins and cancel the brand-new response.
                        input_track._wake_detector.reset()
                if state != "speaking":
                    playback_control["cutoff"] = False
                    playback_control["cutoff_until"] = 0.0
                if _should_arm_after_response(
                    previous_state,
                    state,
                    playback_control["barge_in"],
                    wake_state["assistant_response_seen"],
                ):
                    input_track.arm_for_next_request("the assistant response")
                elif state == "thinking":
                    # A locally detected interruption first moves Live back to
                    # listening. Keep that interrupted request open until the
                    # backend accepts it and starts thinking.
                    playback_control["barge_in"] = False
                if wake_state["active"]:
                    _write_status(
                        state,
                        message=f"GPT Live is {state}.",
                        model=model,
                        voice=config.get("voice", DEFAULT_VOICE),
                        wake_phrase=wake_state["phrase"],
                    )
                else:
                    _write_armed_status(config, model, wake_state["phrase"])
        elif _event_marks_assistant_response(event):
            wake_state["assistant_response_seen"] = True
        elif _handle_completed_assistant_turn(
            event,
            playback_control,
            input_track.arm_for_next_request,
        ):
            _write_armed_status(config, model, wake_state["phrase"])
        elif event.get("type") in ("goodbye", "close_ready"):
            connection_closed.set()

    @data_channel.on("close")
    def on_data_close():
        connection_closed.set()

    @pc.on("track")
    def on_track(track):
        if track.kind == "audio":
            def on_remote_speech_started():
                if wake_state["active"]:
                    wake_state["assistant_response_seen"] = True

            task = asyncio.create_task(_play_remote_audio(
                track,
                config.get("playback_device", "default"),
                AudioResampler,
                playback_control,
                on_remote_speech_started,
            ))
            playback_tasks.add(task)

            def playback_done(completed):
                playback_tasks.discard(completed)
                if completed.cancelled():
                    return
                error = completed.exception()
                if error is not None:
                    playback_error["value"] = error
                    connection_closed.set()

            task.add_done_callback(playback_done)

    @pc.on("connectionstatechange")
    async def on_connection_state_change():
        if pc.connectionState in ("failed", "closed", "disconnected"):
            connection_closed.set()

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await _wait_for_ice_gathering(pc)
    response = await client.post(
        _device_path(config, "/realtime/app-server"),
        json={
            "sdp": pc.localDescription.sdp,
            "session": {"voice": config.get("voice", DEFAULT_VOICE), "model": model},
        },
    )
    response.raise_for_status()
    signaling = response.json()
    live_session_id = signaling["sessionId"]
    await pc.setRemoteDescription(RTCSessionDescription(sdp=signaling["sdp"], type="answer"))
    bridge_task = None
    max_timer = None
    stop_task = None
    close_task = None
    completed_error = None
    try:
        await asyncio.wait_for(data_channel_open.wait(), timeout=10)
        bridge_task = asyncio.create_task(_consume_bridge_events(client, config, live_session_id, connection_closed))
        max_timer = asyncio.create_task(asyncio.sleep(int(config.get("max_session_seconds", 1800))))
        stop_task = asyncio.create_task(stop_event.wait())
        close_task = asyncio.create_task(connection_closed.wait())
        done, _ = await asyncio.wait(
            {bridge_task, max_timer, stop_task, close_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for completed in done:
            if completed.cancelled():
                continue
            error = completed.exception()
            if error is not None:
                completed_error = error
                break
        if playback_error["value"] is not None:
            completed_error = playback_error["value"]
    finally:
        for task in (bridge_task, max_timer, stop_task, close_task, *playback_tasks):
            if task is not None:
                task.cancel()
        input_track.stop()
        await pc.close()
        try:
            await client.delete(_device_path(config, f"/realtime/app-server/{live_session_id}"))
        except Exception:
            log.warning("Could not acknowledge GPT Live server cleanup")
    if completed_error is not None:
        raise completed_error


async def _play_remote_audio(
    track,
    device,
    AudioResampler,
    playback_control,
    on_remote_speech_started=None,
):
    process = _open_playback_process(device)
    resampler = AudioResampler(format="s16", layout="mono", rate=AUDIO_RATE)
    try:
        while True:
            frame = await track.recv()
            for converted in resampler.resample(frame):
                now = time.monotonic()
                if (
                    playback_control["cutoff"]
                    and now >= playback_control.get("cutoff_until", 0.0)
                ):
                    playback_control["cutoff"] = False
                if playback_control["cutoff"]:
                    playback_control["playing_until"] = 0.0
                    # Keep the sink input open while discarding cancelled
                    # frames. Destroying paplay here can tear down the
                    # echo-cancel source and make the microphone stream exit.
                    continue
                if playback_control["muted"]:
                    _set_playback_muted(False)
                    playback_control["muted"] = False
                byte_count = converted.samples * 2
                pcm = bytes(converted.planes[0])[:byte_count]
                audible = _pcm_rms(pcm) >= PLAYBACK_AUDIBLE_RMS
                if audible and now - playback_control.get(
                    "last_audible_at", 0.0
                ) >= PLAYBACK_UTTERANCE_GAP_SECONDS:
                    playback_control["started_at"] = now
                    if callable(on_remote_speech_started):
                        on_remote_speech_started()
                playback_control["last_frame_at"] = now
                if audible:
                    playback_control["last_audible_at"] = now
                    playback_control["playing_until"] = now + 0.2
                if process is None:
                    process = _open_playback_process(device)
                await asyncio.to_thread(process.stdin.write, pcm)
    finally:
        if playback_control["muted"]:
            _set_playback_muted(False)
            playback_control["muted"] = False
        if process is not None:
            _terminate_playback_process(process)


async def _consume_bridge_events(client, config, live_session_id, closed_event):
    path = _device_path(config, f"/realtime/app-server/{live_session_id}/events")
    async with client.stream("GET", path) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type")
            if event_type == "tool.pending_confirmation":
                _write_status(
                    "approval_pending",
                    message="An OpenHome action is waiting for approval in the paired browser control page.",
                    call_id=event.get("callId"),
                    tool=event.get("name"),
                )
            elif event_type == "error":
                _write_status("error", message=str(event.get("message", "Realtime bridge error.")))
            elif event_type == "session.closed":
                closed_event.set()
                return


def decode_realtime_event(message):
    """Decode the direct or nested GPT Live data-channel event envelope."""
    value = message
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    for _ in range(4):
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                return None
            continue
        if isinstance(value, dict) and value.get("type") == "data_message" and "data" in value:
            value = value["data"]
            continue
        break
    return value if isinstance(value, dict) and isinstance(value.get("type"), str) else None


def _is_completed_assistant_turn(event):
    if not isinstance(event, dict) or event.get("type") != "turn.done":
        return False
    turn = event.get("turn")
    return isinstance(turn, dict) and turn.get("role") == "assistant"


def _handle_completed_assistant_turn(event, playback_control, arm_for_next_request):
    """Re-arm at an explicit turn boundary unless a replacement turn is open."""
    if (
        not _is_completed_assistant_turn(event)
        or playback_control.get("barge_in", False)
    ):
        return False
    arm_for_next_request("the completed assistant turn")
    return True


async def _wait_for_ice_gathering(pc):
    if pc.iceGatheringState == "complete":
        return
    complete = asyncio.Event()

    @pc.on("icegatheringstatechange")
    def on_ice_state():
        if pc.iceGatheringState == "complete":
            complete.set()

    await asyncio.wait_for(complete.wait(), timeout=20)


async def _wait_or_stop(stop_event, seconds):
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


def _choose_model(models, preferred):
    models = [model for model in models if isinstance(model, str) and model]
    if preferred and preferred in models:
        return preferred
    if models:
        return models[0]
    raise RuntimeError("The authenticated ChatGPT account returned no Codex models.")


def _device_request_sync(client, config, method, subpath):
    response = client.request(
        method,
        f"{config['server_url']}{_device_path(config, subpath)}",
        headers={"Authorization": f"Bearer {config['device_token']}"},
    )
    response.raise_for_status()
    return response.json()


def _register_device(client, server_url, bootstrap_token, payload):
    return client.post(
        f"{server_url}/api/device/register",
        headers={"Authorization": f"Bearer {bootstrap_token}"},
        json=payload,
    )


def _device_path(config, subpath):
    return f"/api/device/{config['device_id']}/chatgpt{subpath}"


def _device_settings_path(config):
    return f"/api/device/{config['device_id']}/settings"


def _ensure_worker_started():
    pid = _read_worker_pid()
    if pid and _is_our_worker(pid):
        return False
    PID_FILE.unlink(missing_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if _install_and_start_boot_service():
            return True
    except Exception:
        # Older/non-systemd development environments can still use the
        # detached-process fallback below.
        log.exception("Could not start GPT Live through the boot service")
    log_handle = open(WORKER_LOG_FILE, "ab", buffering=0)
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "_worker"],
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=log_handle,
        start_new_session=True,
        close_fds=True,
    )
    log_handle.close()
    PID_FILE.write_text(str(process.pid), encoding="utf-8")
    os.chmod(PID_FILE, 0o600)
    _write_status("starting", message="The headless GPT Live worker is starting.")
    return True


def _install_and_start_boot_service():
    """Install a persistent per-user service and start it immediately."""
    if os.name != "posix" or not shutil.which("systemctl"):
        return False
    SERVICE_FILE.parent.mkdir(parents=True, exist_ok=True)
    unit = _service_unit_text()
    if not SERVICE_FILE.exists() or SERVICE_FILE.read_text(encoding="utf-8") != unit:
        temporary = SERVICE_FILE.with_suffix(f".service.{os.getpid()}.tmp")
        temporary.write_text(unit, encoding="utf-8")
        os.chmod(temporary, 0o644)
        temporary.replace(SERVICE_FILE)
    subprocess.run(
        ["systemctl", "--user", "daemon-reload"],
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    subprocess.run(
        ["systemctl", "--user", "enable", "--now", SERVICE_NAME],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    return subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", SERVICE_NAME],
        timeout=10,
        check=False,
    ).returncode == 0


def _disable_boot_service():
    """Prevent systemd Restart=always from reviving a deliberately stopped worker."""
    if os.name != "posix" or not shutil.which("systemctl") or not SERVICE_FILE.exists():
        return False
    was_active = subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", SERVICE_NAME],
        timeout=10,
        check=False,
    ).returncode == 0
    subprocess.run(
        ["systemctl", "--user", "disable", "--now", SERVICE_NAME],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return was_active


def _service_unit_text():
    worker = Path(__file__).resolve()
    return (
        "[Unit]\n"
        "Description=OpenHome GPT Live voice provider\n"
        "Wants=openhome-dashboard.service\n"
        "After=openhome-dashboard.service pipewire.service pipewire-pulse.service\n\n"
        "[Service]\n"
        "Type=simple\n"
        f"WorkingDirectory={worker.parent}\n"
        "ExecStartPre=/bin/sleep 15\n"
        f"ExecStart={sys.executable} {worker} _worker\n"
        "Restart=always\n"
        "RestartSec=5\n"
        "TimeoutStopSec=15\n"
        "UMask=0077\n"
        "Environment=PYTHONUNBUFFERED=1\n"
        f"StandardOutput=append:{WORKER_LOG_FILE}\n"
        f"StandardError=append:{WORKER_LOG_FILE}\n\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )


def _read_worker_pid():
    try:
        return int(PID_FILE.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, ValueError):
        return None


def _is_our_worker(pid):
    if not pid:
        return False
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8")
        return str(Path(__file__).resolve()) in command and "_worker" in command
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return False


def _read_exact(stream, byte_count):
    chunks = []
    remaining = byte_count
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _capture_command(device):
    if device == "default":
        return [
            "parec", "--raw", f"--device={AEC_SOURCE}", "--format=s16le",
            f"--rate={AUDIO_RATE}", f"--channels={AEC_CHANNELS}",
            "--client-name=OpenHome GPT Live", "--stream-name=GPT Live microphone",
        ]
    return [
        "arecord", "-q", "-D", device,
        "-f", "S16_LE", "-c", "1", "-r", str(AUDIO_RATE), "-t", "raw",
    ]


def _open_capture_process(device):
    return subprocess.Popen(
        _capture_command(device),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )


def _capture_process_error(process):
    if process.poll() is None or process.stderr is None:
        return ""
    try:
        return process.stderr.read(4_096).decode("utf-8", errors="replace").strip()
    except OSError:
        return ""


def _terminate_capture_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()


def _playback_command(device):
    if device == "default":
        return [
            "paplay", "--raw", f"--device={AEC_SINK}", "--format=s16le",
            f"--rate={AUDIO_RATE}", "--channels=1",
            # Forty milliseconds underruns on the DevKit under WebRTC/Python
            # scheduling jitter. Two hundred milliseconds stays smooth while
            # wake-word interruption mutes the sink immediately.
            "--latency-msec=200",
            "--client-name=OpenHome GPT Live", "--stream-name=GPT Live speaker",
        ]
    return [
        "aplay", "-q", "-D", device,
        "-f", "S16_LE", "-c", "1", "-r", str(AUDIO_RATE), "-t", "raw",
    ]


def _open_playback_process(device):
    process = subprocess.Popen(
        _playback_command(device),
        stdin=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
    )
    if process.stdin is None:
        process.terminate()
        raise RuntimeError("Could not open the speaker stream.")
    return process


def _terminate_playback_process(process):
    if process.stdin is not None:
        try:
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
    if process.poll() is None:
        process.terminate()


def _set_playback_muted(muted):
    subprocess.run(
        ["pactl", "set-sink-mute", AEC_SINK, "1" if muted else "0"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=3,
        check=False,
    )


def _ensure_echo_cancel():
    """Create one PipeWire-Pulse WebRTC AEC source/sink for full-duplex voice."""
    modules = _pactl_output("list", "short", "modules")
    sources = _pactl_output("list", "short", "sources")
    sinks = _pactl_output("list", "short", "sinks")
    tuned = "noise_suppression=false" in modules
    if AEC_SOURCE in sources and AEC_SINK in sinks and tuned:
        return

    for line in modules.splitlines():
        fields = line.split("\t", 2)
        if (
            len(fields) == 3
            and fields[1] == "module-echo-cancel"
            and f"source_name={AEC_SOURCE}" in fields[2]
        ):
            subprocess.run(
                ["pactl", "unload-module", fields[0]],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            )

    source_master = _pactl_output("get-default-source").strip()
    sink_master = _pactl_output("get-default-sink").strip()
    if not source_master or not sink_master:
        raise RuntimeError("PipeWire did not report a default microphone and speaker.")

    subprocess.run(
        [
            "pactl", "load-module", "module-echo-cancel",
            "aec_method=webrtc",
            f"source_master={source_master}",
            f"sink_master={sink_master}",
            f"source_name={AEC_SOURCE}",
            f"sink_name={AEC_SINK}",
            f"channels={AEC_CHANNELS}",
            "channel_map=front-left,front-right",
            (
                "aec_args=noise_suppression=false voice_detection=true "
                "extended_filter=true analog_gain_control=false "
                "digital_gain_control=false"
            ),
            "source_properties=device.description=OpenHome_GPT_Live_AEC",
            "sink_properties=device.description=OpenHome_GPT_Live_AEC_Sink",
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if (
            AEC_SOURCE in _pactl_output("list", "short", "sources")
            and AEC_SINK in _pactl_output("list", "short", "sinks")
        ):
            return
        time.sleep(0.1)
    raise RuntimeError("PipeWire echo cancellation did not create its audio devices.")


def _pactl_output(*arguments):
    return subprocess.run(
        ["pactl", *arguments],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    ).stdout


class WakePhraseDetector:
    """Offline keyword spotter; microphone audio never leaves the DevKit while armed."""

    def __init__(self, phrase):
        try:
            from pocketsphinx import Decoder
        except ImportError as error:
            raise RuntimeError("PocketSphinx was not installed for offline wake-word detection.") from error
        self._aliases = _wake_phrase_aliases(phrase)
        grammar_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                suffix=".jsgf",
                encoding="utf-8",
                delete=False,
            ) as grammar_file:
                grammar_file.write(
                    "#JSGF V1.0; grammar wake; public <wake> = "
                    + " | ".join(self._aliases)
                    + ";"
                )
                grammar_path = grammar_file.name
            self._decoder = Decoder(
                jsgf=grammar_path,
                samprate=16_000,
                logfn=os.devnull,
            )
        finally:
            if grammar_path:
                Path(grammar_path).unlink(missing_ok=True)
        self._confirmation_frames = 0
        self._quiet_frames = 0
        self._frames_seen = 0
        self._decoder.start_utt()

    def reset(self):
        self._decoder.end_utt()
        self._decoder.start_utt()
        self._confirmation_frames = 0
        self._quiet_frames = 0

    def process(self, pcm_48k):
        self._frames_seen += 1
        if self._frames_seen == 1:
            log.info("GPT Live wake detector is receiving microphone audio")
        elif self._frames_seen == 250:
            log.info("GPT Live wake detector microphone stream is continuous")
        self._quiet_frames, should_reset = _advance_wake_silence(
            self._quiet_frames,
            pcm_48k,
        )
        if should_reset:
            # Grammar decoding is utterance-oriented. Without silence
            # segmentation a decoder that has been armed for roughly a minute
            # stops recognizing an otherwise clear wake phrase.
            self.reset()
        pcm_16k = _downsample_48k_to_16k(pcm_48k)
        self._decoder.process_raw(pcm_16k, False, False)
        hypothesis = self._decoder.hyp()
        if hypothesis is None:
            self._confirmation_frames = 0
            return False
        heard = hypothesis.hypstr.strip().lower()
        previous_confirmation_frames = self._confirmation_frames
        self._confirmation_frames, confirmed = _advance_wake_confirmation(
            self._confirmation_frames,
            heard,
            float(getattr(hypothesis, "best_score", 0.0)),
            self._aliases,
        )
        if previous_confirmation_frames == 0 and self._confirmation_frames == 1:
            log.info("GPT Live wake candidate: %s (score %.3f)", heard, hypothesis.best_score)
        if confirmed:
            self.reset()
        return confirmed


def _wake_phrase_aliases(phrase):
    normalized = " ".join(str(phrase).replace("-", " ").lower().split())
    # Keep the grammar exact. Broad phonetic aliases such as "june it for"
    # made synthesized playback and ordinary room noise indistinguishable from
    # an owner saying the configured wake name.
    return (normalized,)


def _advance_wake_confirmation(frame_count, heard, score, aliases):
    if heard not in aliases or score < WAKE_GRAMMAR_SCORE_THRESHOLD:
        return 0, False
    frame_count += 1
    if frame_count < WAKE_CONFIRM_FRAMES:
        return frame_count, False
    return 0, True


def _advance_wake_silence(frame_count, pcm):
    samples = array.array("h")
    samples.frombytes(pcm)
    rms = math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples)))
    if rms > WAKE_SILENCE_RMS:
        return 0, False
    frame_count += 1
    if frame_count < WAKE_SILENCE_FRAMES:
        return frame_count, False
    return 0, True


def _select_capture_audio(data, device):
    if device != "default":
        return data
    stereo = array.array("h")
    stereo.frombytes(data)
    return array.array("h", stereo[AEC_CAPTURE_CHANNEL::AEC_CHANNELS]).tobytes()


def _downsample_48k_to_16k(data):
    samples = array.array("h")
    samples.frombytes(data)
    downsampled = array.array(
        "h",
        (
            int(sum(samples[index:index + 3]) / len(samples[index:index + 3]))
            for index in range(0, len(samples), 3)
            if samples[index:index + 3]
        ),
    )
    return downsampled.tobytes()


def _should_return_to_wake_mode(wake_state, remote_state, now=None):
    if not wake_state["active"]:
        return False
    now = time.monotonic() if now is None else now
    return now - wake_state["last_activity"] >= wake_state["idle_seconds"]


def _should_arm_after_response_audio(wake_state, playback_control, now=None):
    if not wake_state.get("active") or not wake_state.get("assistant_response_seen"):
        return False
    now = time.monotonic() if now is None else now
    last_audible_at = playback_control.get("last_audible_at", 0.0)
    if last_audible_at <= 0.0:
        return False
    return (
        now >= playback_control.get("playing_until", 0.0)
        and now - last_audible_at >= PLAYBACK_UTTERANCE_GAP_SECONDS
        and now - wake_state.get("last_user_speech", now) >= REQUEST_END_SILENCE_SECONDS
    )


def _should_arm_after_response(
    previous_state, state, barge_in, assistant_response_seen
):
    # `/wm` does not always return to the exact `listening` state. Treat every
    # non-output ready state as the end of a response, but only after observing
    # assistant output (or a thinking -> ready failure boundary). The WebRTC
    # connection remains untouched so conversation context survives re-arming.
    return (
        not barge_in
        and state in GPT_LIVE_READY_STATES
        and (
            assistant_response_seen
            or previous_state in ("speaking", "thinking")
        )
    )


def _reset_wake_gate(
    wake_state, playback_control, pending, preroll, wake_detector
):
    """Re-arm for Juniper without touching the persistent Live connection."""
    was_active = wake_state["active"]
    wake_state["active"] = False
    wake_state["assistant_response_seen"] = False
    playback_control["barge_in"] = False
    pending.clear()
    preroll.clear()
    wake_detector.reset()
    return was_active


def _event_marks_assistant_response(event):
    """Recognize assistant audio without depending on undocumented turn.done."""
    return isinstance(event, dict) and event.get("type") in {
        "live_captioning_text",
        "speaking_update",
    }


def _write_armed_status(config, model, phrase):
    _write_status(
        "armed",
        message=f"Say {phrase.title()} to start GPT Live.",
        model=model,
        voice=config.get("voice", DEFAULT_VOICE),
        wake_phrase=phrase,
    )


def _maybe_interrupt(data, state, channel, playback_control=None, wake_word=False):
    """Cut output locally while the always-open Live microphone carries barge-in."""
    now = time.monotonic()
    if not _output_is_playing(state, playback_control, now):
        state["hot_frames"] = 0
        return
    # Every request requires the wake phrase. Using raw volume here caused the
    # AEC's tiny far-end residual to interrupt Juniper's own response and close
    # the capture stream. A fresh offline wake-word detection is deterministic
    # and remains usable even when double-talk attenuation makes speech quiet.
    if not wake_word:
        state["hot_frames"] = 0
        return
    rms = _pcm_rms(data)
    if now - state["last_interrupt"] >= 0.8:
        if playback_control is not None:
            playback_control["cutoff"] = True
            playback_control["cutoff_until"] = now + PLAYBACK_INTERRUPT_CUTOFF_SECONDS
            playback_control["barge_in"] = True
            mute_output = playback_control.get("mute_output")
            if callable(mute_output):
                mute_output(True)
                playback_control["muted"] = True
        log.info(
            "GPT Live barge-in detected at %.1f RMS%s; cutting local playback while Live hears the replacement request",
            rms,
            " with wake phrase" if wake_word else "",
        )
        state["last_interrupt"] = now
        state["hot_frames"] = 0


def _output_is_playing(state, playback_control=None, now=None):
    if state.get("value") == "speaking":
        return True
    if not playback_control:
        return False
    now = time.monotonic() if now is None else now
    return (
        now < playback_control.get("playing_until", 0.0)
        and now - playback_control.get("started_at", now) >= WAKE_INTERRUPT_GUARD_SECONDS
    )


def _wake_allowed_during_playback(rms, state, playback_control=None, now=None):
    now = time.monotonic() if now is None else now
    remote_speaking = state.get("value") == "speaking"
    local_playback = bool(
        playback_control
        and now < playback_control.get("playing_until", 0.0)
    )
    if not remote_speaking and not local_playback:
        return True
    # A legitimate mid-answer wake is handled by the active-turn barge-in path.
    # If the ordinary armed gate sees playback, it is an output-tail race or
    # speaker echo and must never open a new request.
    return False


def _pcm_rms(data):
    samples = array.array("h")
    samples.frombytes(data)
    return math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples)))


def _require_audio_commands():
    missing = [
        command
        for command in ("arecord", "aplay", "pactl", "parec", "paplay")
        if not shutil.which(command)
    ]
    if missing:
        raise RuntimeError(f"Missing audio command(s): {', '.join(missing)}.")


def _validate_server_url(value):
    value = str(value).strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme == "https" and parsed.netloc:
        return value
    if parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1"):
        return value
    raise ValueError("The GPT Live server URL must use HTTPS unless it is loopback.")


def _validate_voice(value):
    value = str(value).strip().lower()
    if value not in SUPPORTED_VOICES:
        raise ValueError(
            "The voice must be one of: " + ", ".join(sorted(SUPPORTED_VOICES)) + "."
        )
    return value


def _validate_wake_phrase(value):
    value = " ".join(str(value).strip().lower().split())
    if not value or len(value) > 40 or not re.fullmatch(r"[a-z][a-z -]*", value):
        raise ValueError(
            "The wake phrase must contain 1-40 lowercase English letters, spaces, or hyphens."
        )
    return value


def _validate_active_idle_seconds(value):
    try:
        seconds = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("The GPT Live awake timeout must be a whole number of seconds.") from error
    if not 10 <= seconds <= 300:
        raise ValueError("The GPT Live awake timeout must be between 10 and 300 seconds.")
    return seconds


def _setup_spoken_response(registration, login):
    pairing = registration.get("pairingCode")
    if pairing:
        grouped = f"{pairing[:4]}, {pairing[4:]}"
        return (
            f"Open {registration['setupUrl']} in a trusted browser and enter pairing code {grouped}. "
            "Then authorize ChatGPT there. GPT Live will become active automatically."
        )
    if login.get("status") == "authenticated":
        return "Your browser is already paired. GPT Live is connecting automatically."
    return (
        f"Open {registration['setupUrl']} in your paired browser and finish ChatGPT authorization. "
        "GPT Live will become active automatically."
    )


def _write_status(state, message="", **details):
    payload = {
        "state": state,
        "message": message,
        "updated_at": time.time(),
        **{key: value for key, value in details.items() if value is not None},
    }
    _write_private_json(STATUS_FILE, payload)


def _write_private_json(path, payload):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def _read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def _print_payload(payload):
    output = json.dumps(payload, separators=(",", ":"))
    log.info("GPT Live DevKit action completed: %s", payload.get("success"))
    print(output)


FUNCTION_REGISTRY = {
    "configure_and_start": configure_and_start,
    "stop_live": stop_live,
    "live_status": live_status,
    "audio_devices": audio_devices,
    "_worker": _worker,
}


if __name__ == "__main__":
    function_name = sys.argv[1]
    function = FUNCTION_REGISTRY.get(function_name)
    if function is None:
        raise SystemExit(f"Unknown function: {function_name}")
    function(*sys.argv[2:])
