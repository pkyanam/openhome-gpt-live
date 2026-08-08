import importlib.util
import json
from pathlib import Path
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
main_runtime_module = types.ModuleType("src.main")
main_runtime_module.AgentWorker = AgentWorker
worker_module = types.ModuleType("src.agent.capability_worker")
worker_module.CapabilityWorker = CapabilityWorker
sys.modules.setdefault("src", src_module)
sys.modules.setdefault("src.agent", agent_module)
sys.modules.setdefault("src.agent.capability", capability_module)
sys.modules.setdefault("src.main", main_runtime_module)
sys.modules.setdefault("src.agent.capability_worker", worker_module)

spec = importlib.util.spec_from_file_location(
    "openhome_gpt_live_main",
    Path(__file__).with_name("main.py"),
)
ability_main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ability_main)


class MainDiagnosticsTests(unittest.TestCase):
    def test_speaks_running_state(self):
        ability = ability_main.OpenHomeGPTLiveCapability()
        message = ability._spoken_status({
            "success": True,
            "output": json.dumps({
                "success": True,
                "status": {"state": "armed", "worker_running": True},
            }),
        })
        self.assertEqual(message, "GPT Live is running and its current state is armed.")

    def test_speaks_safe_failure_for_invalid_output(self):
        ability = ability_main.OpenHomeGPTLiveCapability()
        self.assertEqual(
            ability._spoken_status({"success": True, "output": "not json"}),
            "The DevKit returned unreadable GPT Live status.",
        )


if __name__ == "__main__":
    unittest.main()
