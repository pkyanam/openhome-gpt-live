import { describe, expect, test } from "bun:test";
import { createCodexControlPolicy } from "./codex-control.ts";

const baseContext = {
  callId: "call_1",
  name: "codex_prepare_mac_task",
  arguments: { task: "Open Calculator on the Mac" },
  loginSessionId: "login_1",
  liveSessionId: "live_1",
  request: new Request("https://voice.example.test"),
};

describe("confirmed Codex Mac control", () => {
  test("is not exposed unless explicitly enabled", () => {
    const policy = createCodexControlPolicy({
      enabled: false,
      workspace: "/workspace",
    });
    expect(policy.tools).toEqual([]);
  });

  test("prepares a review without running the task", async () => {
    let executions = 0;
    const policy = createCodexControlPolicy({
      enabled: true,
      workspace: "/workspace",
      runTask: async () => {
        executions += 1;
        return { summary: "done" };
      },
    });

    const pending = await policy.executeTool(baseContext);

    expect(executions).toBe(0);
    expect(pending.output).toMatchObject({
      status: "pending_confirmation",
      operation: "codex.mac_task.v1",
      task: "Open Calculator on the Mac",
      workspace: "/workspace",
    });
    expect(pending.pendingConfirmation?.review).toMatchObject({
      title: "Run Codex with Mac access",
    });
  });

  test("runs only after approval and returns a spoken result", async () => {
    const tasks: string[] = [];
    const policy = createCodexControlPolicy({
      enabled: true,
      workspace: "/workspace",
      runTask: async (task) => {
        tasks.push(task);
        return { summary: "Calculator is open." };
      },
    });
    const pending = await policy.executeTool(baseContext);

    const denied = await policy.confirmTool({
      ...baseContext,
      confirmation: { approved: false },
      pending,
    });
    expect(tasks).toEqual([]);
    expect(denied.output).toMatchObject({ status: "cancelled" });

    const approved = await policy.confirmTool({
      ...baseContext,
      confirmation: { approved: true },
      pending,
    });
    expect(tasks).toEqual(["Open Calculator on the Mac"]);
    expect(approved.output).toMatchObject({ status: "completed" });
    expect(approved.speech).toBe("Calculator is open.");
  });
});
