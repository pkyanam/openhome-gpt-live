import json
import sys
import types
import unittest


class MatchingCapability:
    pass


class AgentWorker:
    pass


class CapabilityWorker:
    def __init__(self, capability):
        self.capability = capability


src_module = types.ModuleType("src")
agent_module = types.ModuleType("src.agent")
capability_module = types.ModuleType("src.agent.capability")
capability_module.MatchingCapability = MatchingCapability
main_module = types.ModuleType("src.main")
main_module.AgentWorker = AgentWorker
worker_module = types.ModuleType("src.agent.capability_worker")
worker_module.CapabilityWorker = CapabilityWorker
sys.modules.setdefault("src", src_module)
sys.modules.setdefault("src.agent", agent_module)
sys.modules.setdefault("src.agent.capability", capability_module)
sys.modules.setdefault("src.main", main_module)
sys.modules.setdefault("src.agent.capability_worker", worker_module)

import background


class StopLoop(Exception):
    pass


class FakeLogger:
    def __init__(self):
        self.errors = []

    def error(self, message, *args):
        self.errors.append(message % args if args else message)

    def exception(self, message, *args):
        self.errors.append(message % args if args else message)


class FakeSessionTasks:
    async def sleep(self, _seconds):
        raise StopLoop()


class FakeWorker:
    def __init__(self):
        self.editor_logging_handler = FakeLogger()
        self.session_tasks = FakeSessionTasks()


class FakeCapabilityWorker:
    def __init__(self):
        self.calls = []
        self.spoken = []

    def get_api_keys(self, name):
        values = {
            "openhome_gpt_live_server_url": "https://voice.example.test",
            "openhome_gpt_live_bootstrap_token": "b" * 64,
        }
        return values.get(name)

    async def send_devkit_capability_action(self, function_name, args, timeout):
        self.calls.append((function_name, args, timeout))
        if function_name == "live_status":
            payload = {"success": True, "status": {"state": "stopped", "worker_running": False}}
        elif function_name == "configure_and_start":
            payload = {
                "success": True,
                "pairing_code": "12345678",
                "spoken_response": "Pair this phone.",
            }
        else:
            payload = {"success": True, "stopped": True}
        return {"success": True, "output": json.dumps(payload)}

    async def send_interrupt_signal(self):
        return None

    async def speak(self, message):
        self.spoken.append(message)


class BackgroundProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_auto_starts_announces_pairing_and_cleans_up(self):
        capability = background.OpenHomeGPTLiveBackgroundCapability()
        capability.worker = FakeWorker()
        capability.capability_worker = FakeCapabilityWorker()

        with self.assertRaises(StopLoop):
            await capability.provider_loop()

        names = [call[0] for call in capability.capability_worker.calls]
        self.assertEqual(names, ["live_status", "configure_and_start", "stop_live"])
        self.assertEqual(capability.capability_worker.spoken, ["Pair this phone."])
        configure_args = capability.capability_worker.calls[1][1]
        self.assertEqual(configure_args[-2:], ["juniper", "30"])


if __name__ == "__main__":
    unittest.main()
