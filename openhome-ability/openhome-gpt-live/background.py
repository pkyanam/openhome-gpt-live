import json
from src.agent.capability import MatchingCapability
from src.main import AgentWorker
from src.agent.capability_worker import CapabilityWorker


class OpenHomeGPTLiveBackgroundCapability(MatchingCapability):
    """Keep GPT Live active for the complete OpenHome Personality session."""

    worker: AgentWorker = None
    capability_worker: CapabilityWorker = None
    background_daemon_mode: bool = False

    #{{register capability}}

    async def provider_loop(self):
        announced_configuration_error = False
        announced_runtime_error = False
        announced_authorization = False
        stopped_for_missing_configuration = False
        retry_seconds = 5.0

        try:
            while True:
                server_url = self.capability_worker.get_api_keys(
                    "openhome_gpt_live_server_url"
                )
                bootstrap_token = self.capability_worker.get_api_keys(
                    "openhome_gpt_live_bootstrap_token"
                )

                if not server_url or not bootstrap_token:
                    if not stopped_for_missing_configuration:
                        await self._devkit_call("stop_live", [], timeout=12)
                        stopped_for_missing_configuration = True
                    if not announced_configuration_error:
                        self.worker.editor_logging_handler.error(
                            "GPT Live needs openhome_gpt_live_server_url and "
                            "openhome_gpt_live_bootstrap_token."
                        )
                        await self._announce(
                            "GPT Live needs its server address and enrollment key "
                            "in the OpenHome settings."
                        )
                        announced_configuration_error = True
                    await self.worker.session_tasks.sleep(30.0)
                    continue

                announced_configuration_error = False
                stopped_for_missing_configuration = False
                status_result = await self._devkit_call("live_status", [], timeout=10)
                status_payload = self._payload(status_result)
                status = status_payload.get("status", {})
                worker_running = bool(status.get("worker_running"))

                if worker_running:
                    state = status.get("state", "unknown")
                    if (
                        state == "awaiting_chatgpt_auth"
                        and not announced_authorization
                    ):
                        await self._announce(
                            self._authorization_message(status)
                        )
                        announced_authorization = True
                    if state == "live":
                        announced_runtime_error = False
                        announced_authorization = False
                    retry_seconds = 5.0
                    await self.worker.session_tasks.sleep(
                        5.0 if state in ("starting", "connecting", "awaiting_chatgpt_auth") else 12.0
                    )
                    continue

                start_result = await self._devkit_call(
                    "configure_and_start",
                    self._configuration_args(server_url, bootstrap_token),
                    timeout=50,
                )
                start = self._payload(start_result)
                if start.get("success"):
                    announced_runtime_error = False
                    retry_seconds = 5.0
                    if (
                        (start.get("pairing_code") or start.get("user_code"))
                        and not announced_authorization
                    ):
                        await self._announce(
                            start.get("spoken_response")
                            or "Open the GPT Live setup page on your phone to authorize ChatGPT."
                        )
                        announced_authorization = True
                else:
                    message = self._error_message(start)
                    self.worker.editor_logging_handler.error(
                        "GPT Live provider start failed: %s", message
                    )
                    if not announced_runtime_error:
                        await self._announce(
                            "GPT Live could not take over the voice pipeline. "
                            "Check the DevKit logs."
                        )
                        announced_runtime_error = True
                    retry_seconds = min(retry_seconds * 2.0, 60.0)

                await self.worker.session_tasks.sleep(retry_seconds)
        finally:
            try:
                await self._devkit_call("stop_live", [], timeout=12)
            except Exception:
                self.worker.editor_logging_handler.exception(
                    "GPT Live provider cleanup failed."
                )

    def _configuration_args(self, server_url, bootstrap_token):
        return [
            server_url,
            bootstrap_token,
            self.capability_worker.get_api_keys("openhome_gpt_live_model") or "",
            self.capability_worker.get_api_keys("openhome_gpt_live_voice") or "vale",
            self.capability_worker.get_api_keys("openhome_gpt_live_capture_device") or "default",
            self.capability_worker.get_api_keys("openhome_gpt_live_playback_device") or "default",
            self.capability_worker.get_api_keys("openhome_gpt_live_wake_phrase") or "juniper",
            self.capability_worker.get_api_keys("openhome_gpt_live_awake_timeout_seconds") or "30",
        ]

    async def _announce(self, message):
        try:
            await self.capability_worker.send_interrupt_signal()
            await self.capability_worker.speak(message)
        except Exception:
            self.worker.editor_logging_handler.exception(
                "GPT Live announcement failed."
            )

    async def _devkit_call(self, function_name, args, timeout):
        try:
            return await self.capability_worker.send_devkit_capability_action(
                function_name=function_name,
                args=args,
                timeout=timeout,
            )
        except Exception as error:
            self.worker.editor_logging_handler.exception(
                "GPT Live DevKit action %s failed.", function_name
            )
            return {
                "success": False,
                "error": str(error),
            }

    def _payload(self, result):
        if not isinstance(result, dict) or not result.get("success"):
            result_error = result.get("error") if isinstance(result, dict) else None
            return {
                "success": False,
                "error": {
                    "message": str(result_error or "The DevKit action did not complete.")
                },
            }
        output = (result.get("output") or "").strip()
        if not output:
            return {
                "success": False,
                "error": {"message": "The DevKit returned no result."},
            }
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            return {
                "success": False,
                "error": {"message": "The DevKit returned invalid JSON."},
            }

    def _authorization_message(self, status):
        setup_url = status.get("setup_url")
        pairing_code = status.get("pairing_code")
        if setup_url and pairing_code:
            grouped = f"{pairing_code[:4]}, {pairing_code[4:]}"
            return (
                f"Open {setup_url} on your phone and enter pairing code {grouped}. "
                "Then authorize ChatGPT. GPT Live will become active automatically."
            )
        if setup_url:
            return (
                f"Open {setup_url} on your paired phone and finish ChatGPT authorization. "
                "GPT Live will become active automatically."
            )
        return "Finish ChatGPT authorization on the paired GPT Live setup page."

    def _error_message(self, payload):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or "unknown error")
        return str(error or "unknown error")

    def call(self, worker: AgentWorker, background_daemon_mode: bool):
        self.worker = worker
        self.background_daemon_mode = background_daemon_mode
        self.capability_worker = CapabilityWorker(self)
        self.worker.session_tasks.create(self.provider_loop())
