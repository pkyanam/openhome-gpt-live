from src.agent.capability import MatchingCapability
from src.main import AgentWorker
from src.agent.capability_worker import CapabilityWorker


class OpenHomeGPTLiveCapability(MatchingCapability):
    """Interactive fallback; GPT Live itself starts from background.py."""

    worker: AgentWorker = None
    capability_worker: CapabilityWorker = None

    #{{register capability}}

    async def first_function(self):
        try:
            result = await self.capability_worker.send_devkit_capability_action(
                function_name="live_status",
                args=[],
                timeout=10,
            )
            await self.capability_worker.speak(self._spoken_status(result))
        except Exception:
            self.worker.editor_logging_handler.exception(
                "GPT Live interactive diagnostics failed."
            )
            await self.capability_worker.speak(
                "I couldn't read GPT Live status. Check the DevKit logs."
            )
        finally:
            self.capability_worker.resume_normal_flow()

    def _spoken_status(self, result):
        if not isinstance(result, dict) or not result.get("success"):
            return "GPT Live diagnostics could not reach the DevKit worker."
        output = (result.get("output") or "").strip()
        if not output:
            return "The DevKit worker returned no GPT Live status."
        try:
            import json
            payload = json.loads(output)
            status = payload.get("status", {})
        except Exception:
            return "The DevKit returned unreadable GPT Live status."
        state = str(status.get("state") or "unknown").replace("_", " ")
        if bool(status.get("worker_running")):
            return f"GPT Live is running and its current state is {state}."
        return f"GPT Live is not running. Its last state was {state}. Check the DevKit logs."

    def call(self, worker: AgentWorker):
        self.worker = worker
        self.capability_worker = CapabilityWorker(self)
        self.worker.session_tasks.create(self.first_function())
