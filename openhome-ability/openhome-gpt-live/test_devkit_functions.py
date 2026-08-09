import json
import io
import array
import asyncio
from collections import deque
from contextlib import redirect_stdout
from pathlib import Path
import sys
import tempfile
import types
import unittest

try:
    import httpx  # noqa: F401
except ModuleNotFoundError:
    # Pure protocol tests do not make HTTP calls; the DevKit installs httpx
    # from requirements.txt before running the Ability.
    sys.modules["httpx"] = types.ModuleType("httpx")

import devkit_functions as live


class DevKitProtocolTests(unittest.TestCase):
    def test_wake_preroll_cannot_starve_the_following_prompt(self):
        replay_seconds = (
            live.WAKE_PREROLL_FRAMES * live.AUDIO_SAMPLES / live.AUDIO_RATE
        )
        capture_bytes = (
            live.WAKE_PREROLL_FRAMES * live.AUDIO_BYTES * live.AEC_CHANNELS
        )

        self.assertLessEqual(replay_seconds, 0.1)
        self.assertLess(capture_bytes, 64 * 1024)

    def test_decodes_direct_and_nested_realtime_events(self):
        event = {"type": "state_update", "payload": {"new_state": "speaking"}}
        nested = json.dumps({"type": "data_message", "data": json.dumps(event)})
        self.assertEqual(live.decode_realtime_event(event), event)
        self.assertEqual(live.decode_realtime_event(nested), event)
        self.assertIsNone(live.decode_realtime_event("not-json"))
        self.assertIsNone(live.decode_realtime_event({"missing": "type"}))

    def test_completed_assistant_turn_is_a_hard_wake_boundary(self):
        self.assertTrue(live._is_completed_assistant_turn({
            "type": "turn.done",
            "turn": {"role": "assistant", "transcript": "Done."},
        }))
        self.assertFalse(live._is_completed_assistant_turn({
            "type": "turn.done",
            "turn": {"role": "user", "transcript": "Juniper"},
        }))
        self.assertFalse(live._is_completed_assistant_turn({
            "type": "state_update",
            "payload": {"new_state": "listening"},
        }))

    def test_interrupted_turn_completion_keeps_replacement_request_open(self):
        event = {
            "type": "turn.done",
            "turn": {"role": "assistant", "transcript": "Interrupted."},
        }
        arm_calls = []

        handled = live._handle_completed_assistant_turn(
            event,
            {"barge_in": True},
            arm_calls.append,
        )

        self.assertFalse(handled)
        self.assertEqual(arm_calls, [])

        handled = live._handle_completed_assistant_turn(
            event,
            {"barge_in": False},
            arm_calls.append,
        )

        self.assertTrue(handled)
        self.assertEqual(arm_calls, ["the completed assistant turn"])

    def test_selects_an_entitled_model(self):
        self.assertEqual(live._choose_model(["one", "two"], "two"), "two")
        self.assertEqual(live._choose_model(["one", "two"], "missing"), "one")
        with self.assertRaisesRegex(RuntimeError, "no Codex models"):
            live._choose_model([], "")

    def test_accepts_only_supported_chatgpt_voices(self):
        self.assertEqual(live._validate_voice(" Vale "), "vale")
        self.assertEqual(live._validate_voice("Juniper"), "juniper")
        with self.assertRaisesRegex(ValueError, "must be one of"):
            live._validate_voice("made-up")

    def test_syncs_browser_selected_voice_and_wake_name_before_live_connects(self):
        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {"voice": "vale", "wakePhrase": "maple"}

        class Client:
            def __init__(self):
                self.paths = []

            async def get(self, path):
                self.paths.append(path)
                return Response()

        original = live.CONFIG_FILE
        with tempfile.TemporaryDirectory() as directory:
            live.CONFIG_FILE = Path(directory) / "config.json"
            client = Client()
            config = {
                "device_id": "dev_1",
                "voice": "juniper",
                "wake_phrase": "juniper",
            }
            try:
                asyncio.run(live._sync_device_settings(client, config))
                saved = json.loads(live.CONFIG_FILE.read_text(encoding="utf-8"))
            finally:
                live.CONFIG_FILE = original

        self.assertEqual(client.paths, ["/api/device/dev_1/settings"])
        self.assertEqual(config["voice"], "vale")
        self.assertEqual(config["wake_phrase"], "maple")
        self.assertEqual(saved["voice"], "vale")
        self.assertEqual(saved["wake_phrase"], "maple")

    def test_announces_each_physical_wake_as_a_server_voice_transaction(self):
        class Response:
            def raise_for_status(self):
                return None

        class Client:
            def __init__(self):
                self.calls = []

            async def post(self, path, json):
                self.calls.append((path, json))
                return Response()

        client = Client()
        asyncio.run(live._announce_voice_turn(
            client,
            {"device_id": "dev_1"},
            "live_1",
            "voice_turn_0001",
        ))

        self.assertEqual(client.calls, [(
            "/api/device/dev_1/chatgpt/realtime/app-server/live_1/turn",
            {"turnId": "voice_turn_0001"},
        )])

    def test_reconnects_in_process_and_applies_a_new_browser_voice(self):
        voices = []
        statuses = []
        sync_count = 0

        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {"models": ["gpt-live-test"]}

        class Client:
            async def get(self, _path):
                return Response()

        async def fake_wait_for_auth(_client, _config, _stop_event):
            return {"user": {"email": "owner@example.test"}}

        async def fake_sync(_client, config):
            nonlocal sync_count
            sync_count += 1
            if sync_count == 2:
                config["voice"] = "vale"

        async def fake_run_live(_client, config, _model, stop_event):
            voices.append(config["voice"])
            if len(voices) == 2:
                stop_event.set()

        async def fake_wait(_stop_event, _seconds):
            return None

        originals = (
            live._wait_for_chatgpt_auth,
            live._sync_device_settings,
            live._run_live_session,
            live._wait_or_stop,
            live._write_status,
        )
        live._wait_for_chatgpt_auth = fake_wait_for_auth
        live._sync_device_settings = fake_sync
        live._run_live_session = fake_run_live
        live._wait_or_stop = fake_wait
        live._write_status = lambda state, **details: statuses.append((state, details))
        try:
            asyncio.run(live._run_reconnecting_worker(
                Client(),
                {"device_id": "dev_1", "voice": "juniper", "preferred_model": ""},
                asyncio.Event(),
            ))
        finally:
            (
                live._wait_for_chatgpt_auth,
                live._sync_device_settings,
                live._run_live_session,
                live._wait_or_stop,
                live._write_status,
            ) = originals

        self.assertEqual(voices, ["juniper", "vale"])
        self.assertIn("reconnecting", [state for state, _details in statuses])
        self.assertEqual(statuses[-1][0], "stopped")

    def test_requires_https_except_loopback(self):
        self.assertEqual(live._validate_server_url("https://voice.example.test/"), "https://voice.example.test")
        self.assertEqual(live._validate_server_url("http://127.0.0.1:3000"), "http://127.0.0.1:3000")
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            live._validate_server_url("http://192.168.1.20:3000")

    def test_spoken_pairing_code_is_grouped(self):
        response = live._setup_spoken_response(
            {"pairingCode": "12345678", "setupUrl": "https://voice.example.test/setup"},
            {"status": "pending"},
        )
        self.assertIn("1234, 5678", response)
        self.assertIn("https://voice.example.test/setup", response)

    def test_status_exposes_only_current_pairing_setup_values(self):
        originals = (
            live.CONFIG_FILE,
            live.STATUS_FILE,
            live.PID_FILE,
            live._read_worker_pid,
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live.CONFIG_FILE = root / "config.json"
            live.STATUS_FILE = root / "status.json"
            live.PID_FILE = root / "worker.pid"
            live.CONFIG_FILE.write_text(json.dumps({
                "setup_url": "https://voice.example.test/setup",
                "pairing_code": "12345678",
                "pairing_issued_at": live.time.time(),
            }))
            live.STATUS_FILE.write_text(json.dumps({"state": "awaiting_chatgpt_auth"}))
            live._read_worker_pid = lambda: None
            output = io.StringIO()
            try:
                with redirect_stdout(output):
                    live.live_status()
            finally:
                (
                    live.CONFIG_FILE,
                    live.STATUS_FILE,
                    live.PID_FILE,
                    live._read_worker_pid,
                ) = originals

        payload = json.loads(output.getvalue())
        self.assertEqual(payload["status"]["pairing_code"], "12345678")
        self.assertEqual(payload["status"]["setup_url"], "https://voice.example.test/setup")

    def test_boot_service_restarts_the_worker(self):
        unit = live._service_unit_text()
        self.assertIn("WantedBy=default.target", unit)
        self.assertIn("Restart=always", unit)
        self.assertIn("UMask=0077", unit)
        self.assertIn("ExecStartPre=/bin/sleep 15", unit)
        self.assertIn("devkit_functions.py _worker", unit)
        self.assertIn("/.local/share/openhome-gpt-live/runtime/", unit)

    def test_stages_worker_outside_the_firmware_managed_ability_tree(self):
        original = live.STATE_DIR
        with tempfile.TemporaryDirectory() as directory:
            live.STATE_DIR = Path(directory)
            try:
                self.assertTrue(live._stage_worker_runtime())
                target = live._runtime_worker_file()
                self.assertTrue(target.is_file())
                self.assertEqual(target.read_bytes(), Path(live.__file__).read_bytes())
                self.assertTrue(target.stat().st_mode & 0o600)
                self.assertFalse(live._stage_worker_runtime())
            finally:
                live.STATE_DIR = original

    def test_default_audio_uses_pipewire_echo_cancellation(self):
        capture = live._capture_command("default")
        playback = live._playback_command("default")
        self.assertEqual(capture[0], "parec")
        self.assertIn(f"--device={live.AEC_SOURCE}", capture)
        self.assertEqual(playback[0], "paplay")
        self.assertIn(f"--device={live.AEC_SINK}", playback)
        self.assertIn("--latency-msec=200", playback)
        self.assertEqual(live._capture_command("hw:1")[0], "arecord")
        self.assertEqual(live._playback_command("hw:1")[0], "aplay")

    def test_default_agent_guard_targets_only_firmware_chromium_audio(self):
        self.assertTrue(live._is_default_agent_audio_stream({
            "properties": {
                "application.name": "Chromium input",
                "application.process.binary": "chromium",
            },
        }))
        self.assertFalse(live._is_default_agent_audio_stream({
            "properties": {
                "application.name": "OpenHome GPT Live",
                "application.process.binary": "pacat",
            },
        }))
        self.assertFalse(live._is_default_agent_audio_stream({"properties": {}}))

    def test_voicehat_capture_uses_the_right_channel(self):
        stereo = array.array("h", [1, 10, 2, 20, 3, 30]).tobytes()
        selected = array.array("h")
        selected.frombytes(live._select_capture_audio(stereo, "default"))
        self.assertEqual(selected.tolist(), [10, 20, 30])
        self.assertEqual(live._select_capture_audio(stereo, "hw:1"), stereo)

    def test_downsamples_wake_audio_to_sixteen_kilohertz(self):
        source = array.array("h", [3, 6, 9, 12, 15, 18]).tobytes()
        downsampled = array.array("h")
        downsampled.frombytes(live._downsample_48k_to_16k(source))
        self.assertEqual(downsampled.tolist(), [6, 15])

    def test_wake_grammar_uses_only_the_configured_name(self):
        aliases = live._wake_phrase_aliases("Juniper")
        self.assertEqual(aliases, ("juniper",))
        self.assertEqual(live._wake_phrase_aliases("Hey-Home"), ("hey home",))

    def test_wake_grammar_confirms_exact_hits_inside_a_short_window(self):
        aliases = live._wake_phrase_aliases("juniper")
        frames = 0
        deadline = 0.0
        for _ in range(live.WAKE_CONFIRM_FRAMES - 1):
            frames, deadline, confirmed = live._advance_wake_confirmation(
                frames, deadline, "juniper", 0.85, aliases, 10.0
            )
            self.assertFalse(confirmed)

        frames, deadline, confirmed = live._advance_wake_confirmation(
            frames, deadline, "juniper", 0.85, aliases, 10.1
        )
        self.assertTrue(confirmed)
        self.assertEqual(frames, 0)

        frames, deadline, confirmed = live._advance_wake_confirmation(
            2, 10.8, "juniper", 0.79, aliases, 10.2
        )
        self.assertFalse(confirmed)
        self.assertEqual(frames, 0)
        self.assertEqual(deadline, 0.0)

        frames, deadline, confirmed = live._advance_wake_confirmation(
            live.WAKE_CONFIRM_FRAMES - 1,
            10.8,
            "june a per",
            0.99,
            aliases,
            10.2,
        )
        self.assertFalse(confirmed)
        self.assertEqual(frames, 0)
        self.assertEqual(deadline, 0.0)

    def test_wake_grammar_tolerates_brief_blank_frames_but_not_old_hits(self):
        aliases = live._wake_phrase_aliases("lara")
        frames, deadline, confirmed = live._advance_wake_confirmation(
            0, 0.0, "lara", 0.90, aliases, 20.0
        )
        self.assertFalse(confirmed)

        frames, deadline, confirmed = live._advance_wake_confirmation(
            frames, deadline, None, 0.0, aliases, 20.3
        )
        self.assertFalse(confirmed)
        self.assertEqual(frames, 1)

        frames, deadline, confirmed = live._advance_wake_confirmation(
            frames, deadline, "lara", 0.88, aliases, 20.4
        )
        self.assertFalse(confirmed)
        self.assertEqual(frames, 2)

        frames, deadline, confirmed = live._advance_wake_confirmation(
            frames, deadline, "lara", 0.91, aliases, 20.5
        )
        self.assertTrue(confirmed)

        frames, deadline, confirmed = live._advance_wake_confirmation(
            1, 30.8, "lara", 0.92, aliases, 31.0
        )
        self.assertFalse(confirmed)
        self.assertEqual(frames, 1)
        self.assertAlmostEqual(deadline, 31.8)

    def test_wake_decoder_segments_long_silence(self):
        quiet = array.array("h", [2] * live.AUDIO_SAMPLES).tobytes()
        frames = 0
        for _ in range(live.WAKE_SILENCE_FRAMES - 1):
            frames, should_reset = live._advance_wake_silence(frames, quiet)
            self.assertFalse(should_reset)

        frames, should_reset = live._advance_wake_silence(frames, quiet)
        self.assertTrue(should_reset)
        self.assertEqual(frames, 0)

        speech = array.array("h", [200] * live.AUDIO_SAMPLES).tobytes()
        frames, should_reset = live._advance_wake_silence(12, speech)
        self.assertFalse(should_reset)
        self.assertEqual(frames, 0)

    def test_recycles_a_live_transport_that_stops_answering_after_search(self):
        wake = {
            "active": True,
            "assistant_response_seen": False,
            "last_activity": 100.0,
            "idle_seconds": 30,
        }
        self.assertFalse(
            live._should_recycle_unresponsive_session(wake, now=114.9)
        )
        self.assertTrue(
            live._should_recycle_unresponsive_session(wake, now=115.0)
        )

        wake["assistant_response_seen"] = True
        self.assertFalse(
            live._should_recycle_unresponsive_session(wake, now=200.0)
        )

        wake["active"] = False
        wake["assistant_response_seen"] = False
        self.assertFalse(
            live._should_recycle_unresponsive_session(wake, now=200.0)
        )

    def test_response_audio_rearms_only_after_playback_and_user_speech_end(self):
        wake = {
            "active": True,
            "assistant_response_seen": True,
            "last_user_speech": 99.0,
        }
        playback = {"last_audible_at": 100.0, "playing_until": 100.2}
        self.assertFalse(live._should_arm_after_response_audio(
            wake, playback, now=100.1
        ))
        self.assertFalse(live._should_arm_after_response_audio(
            wake, playback, now=100.59
        ))
        self.assertTrue(live._should_arm_after_response_audio(
            wake, playback, now=100.61
        ))
        wake["assistant_response_seen"] = False
        self.assertFalse(live._should_arm_after_response_audio(
            wake, playback, now=120.0
        ))

    def test_rearming_closes_mic_and_clears_stale_wake_audio(self):
        class Detector:
            def __init__(self):
                self.resets = 0

            def reset(self):
                self.resets += 1

        wake = {"active": True, "assistant_response_seen": True}
        playback = {"barge_in": True}
        pending = deque([b"old request"])
        preroll = deque([b"old speaker tail"])
        detector = Detector()

        was_active = live._reset_wake_gate(
            wake, playback, pending, preroll, detector
        )

        self.assertTrue(was_active)
        self.assertFalse(wake["active"])
        self.assertFalse(wake["assistant_response_seen"])
        self.assertFalse(playback["barge_in"])
        self.assertEqual(list(pending), [])
        self.assertEqual(list(preroll), [])
        self.assertEqual(detector.resets, 1)

    def test_requires_wake_word_after_each_completed_response(self):
        for ready_state in ("idle", "connected", "listening", "listening_intently"):
            with self.subTest(ready_state=ready_state):
                self.assertTrue(live._should_arm_after_response(
                    "speaking",
                    ready_state,
                    barge_in=False,
                    assistant_response_seen=True,
                ))
        self.assertTrue(live._should_arm_after_response(
            "thinking",
            "connected",
            barge_in=False,
            assistant_response_seen=False,
        ))
        self.assertFalse(live._should_arm_after_response(
            "speaking",
            "listening",
            barge_in=True,
            assistant_response_seen=True,
        ))
        self.assertFalse(live._should_arm_after_response(
            "listening_intently",
            "listening",
            barge_in=False,
            assistant_response_seen=False,
        ))

    def test_real_gpt_live_events_mark_assistant_output(self):
        self.assertTrue(live._event_marks_assistant_response({
            "type": "live_captioning_text",
            "payload": {"text": "Hello"},
        }))
        self.assertTrue(live._event_marks_assistant_response({
            "type": "speaking_update",
        }))
        self.assertFalse(live._event_marks_assistant_response({
            "type": "user_transcription_text",
            "payload": {"text": "Juniper"},
        }))

    def test_validates_wake_configuration(self):
        self.assertEqual(live._validate_wake_phrase("  Hey   Juniper "), "hey juniper")
        self.assertEqual(live._validate_active_idle_seconds("30"), 30)
        with self.assertRaises(ValueError):
            live._validate_wake_phrase("juniper!")
        with self.assertRaises(ValueError):
            live._validate_active_idle_seconds("5")

    def test_wake_word_sends_native_barge_in_while_live_is_speaking(self):
        class Channel:
            readyState = "open"

            def __init__(self):
                self.messages = []

            def send(self, message):
                self.messages.append(message)

        channel = Channel()
        state = {
            "value": "speaking",
            "hot_frames": 0,
            "last_interrupt": 0.0,
        }
        playback = {"cutoff": False, "barge_in": False}
        loud_frame = array.array("h", [2_000] * live.AUDIO_SAMPLES).tobytes()
        for _ in range(live.WAKE_INTERRUPT_HOT_FRAMES - 1):
            live._maybe_interrupt(loud_frame, state, channel, playback)
        live._maybe_interrupt(
            loud_frame,
            state,
            channel,
            playback,
            wake_word=True,
        )

        self.assertEqual(channel.messages, [])
        self.assertTrue(playback["cutoff"])
        self.assertTrue(playback["cutoff_until"] > live.time.monotonic())
        self.assertTrue(playback["barge_in"])

    def test_quiet_audio_does_not_interrupt(self):
        class Channel:
            readyState = "open"

            def __init__(self):
                self.messages = []

            def send(self, message):
                self.messages.append(message)

        channel = Channel()
        state = {
            "value": "speaking",
            "hot_frames": 0,
            "last_interrupt": 0.0,
        }
        quiet_frame = array.array("h", [2] * live.AUDIO_SAMPLES).tobytes()
        for _ in range(20):
            live._maybe_interrupt(quiet_frame, state, channel)
        self.assertEqual(channel.messages, [])

    def test_volume_alone_does_not_barge_in_without_wake_word(self):
        class Channel:
            readyState = "open"

            def __init__(self):
                self.messages = []

            def send(self, message):
                self.messages.append(message)

        now = live.time.monotonic()
        channel = Channel()
        state = {
            "value": "listening",
            "hot_frames": 0,
            "last_interrupt": 0.0,
        }
        playback = {
            "cutoff": False,
            "barge_in": False,
            "started_at": now - 1.0,
            "playing_until": now + 1.0,
        }
        speech = array.array("h", [10] * live.AUDIO_SAMPLES).tobytes()
        for _ in range(20):
            live._maybe_interrupt(speech, state, channel, playback)
        self.assertEqual(channel.messages, [])
        self.assertFalse(playback["cutoff"])

    def test_attenuated_echo_wake_does_not_interrupt_playback(self):
        class Channel:
            readyState = "open"

            def __init__(self):
                self.messages = []

            def send(self, message):
                self.messages.append(message)

        now = live.time.monotonic()
        channel = Channel()
        state = {
            "value": "speaking",
            "hot_frames": 0,
            "last_interrupt": 0.0,
        }
        playback = {
            "cutoff": False,
            "barge_in": False,
            "started_at": now - 1.0,
            "playing_until": now + 1.0,
        }
        attenuated = array.array("h", [3] * live.AUDIO_SAMPLES).tobytes()
        live._maybe_interrupt(
            attenuated,
            state,
            channel,
            playback,
            wake_word=True,
        )
        self.assertEqual(channel.messages, [])
        self.assertFalse(playback["cutoff"])

    def test_wake_interrupt_requires_sustained_near_end_speech(self):
        now = live.time.monotonic()
        state = {"value": "speaking", "hot_frames": 0, "last_interrupt": 0.0}
        playback = {
            "cutoff": False,
            "barge_in": False,
            "started_at": now - 1.0,
            "playing_until": now + 1.0,
        }
        speech = array.array("h", [100] * live.AUDIO_SAMPLES).tobytes()
        for _ in range(live.WAKE_INTERRUPT_HOT_FRAMES - 1):
            live._maybe_interrupt(speech, state, None, playback)
        live._maybe_interrupt(speech, state, None, playback, wake_word=True)
        self.assertTrue(playback["cutoff"])
        self.assertTrue(playback["barge_in"])

    def test_new_wake_does_not_cancel_next_turn_during_old_playback_tail(self):
        class Channel:
            readyState = "open"

            def __init__(self):
                self.messages = []

            def send(self, message):
                self.messages.append(message)

        now = live.time.monotonic()
        channel = Channel()
        state = {
            "value": "listening",
            "hot_frames": 0,
            "last_interrupt": 0.0,
        }
        playback = {
            "cutoff": False,
            "barge_in": False,
            "playing_until": now + 0.2,
        }
        wake = array.array("h", [10] * live.AUDIO_SAMPLES).tobytes()

        live._maybe_interrupt(wake, state, channel, playback, wake_word=True)

        self.assertEqual(channel.messages, [])
        self.assertFalse(playback["cutoff"])

    def test_local_playback_energy_marks_output_as_speaking_without_wm_events(self):
        now = live.time.monotonic()
        playback = {
            "started_at": now - live.WAKE_INTERRUPT_GUARD_SECONDS,
            "playing_until": now + 0.2,
        }
        self.assertTrue(live._output_is_playing(
            {"value": "connecting"}, playback, now
        ))
        self.assertFalse(live._output_is_playing(
            {"value": "connecting"}, playback, now + 0.3
        ))

    def test_speaker_echo_cannot_reopen_wake_gate_during_playback(self):
        now = live.time.monotonic()
        playback = {
            "started_at": now - 2.0,
            "playing_until": now + 0.2,
        }
        self.assertFalse(live._wake_allowed_during_playback(
            119,
            {"value": "connecting"},
            playback,
            now,
        ))
        self.assertFalse(live._wake_allowed_during_playback(
            2_000,
            {"value": "connecting"},
            playback,
            now,
        ))
        self.assertTrue(live._wake_allowed_during_playback(
            0,
            {"value": "listening"},
            {"started_at": 0.0, "playing_until": 0.0},
            now,
        ))

    def test_pcm_rms_detects_audible_playback(self):
        quiet = array.array("h", [2] * live.AUDIO_SAMPLES).tobytes()
        speech = array.array("h", [200] * live.AUDIO_SAMPLES).tobytes()
        self.assertLess(live._pcm_rms(quiet), live.PLAYBACK_AUDIBLE_RMS)
        self.assertGreater(live._pcm_rms(speech), live.PLAYBACK_AUDIBLE_RMS)


if __name__ == "__main__":
    unittest.main()
