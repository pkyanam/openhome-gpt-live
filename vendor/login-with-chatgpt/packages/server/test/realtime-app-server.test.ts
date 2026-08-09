import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  ChatGPTRealtimeAppServerSession,
  chatgptPlanType,
  realtimeClockContext,
  realtimeExecutionConfig,
  type RealtimeBridgeEvent,
} from "../src/realtime-app-server.ts";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function mockStartedSession(
  session: ChatGPTRealtimeAppServerSession,
  requests: Array<{ method: string; params: Record<string, unknown> }> = [],
): void {
  let threadNumber = 0;
  (session as any).threadId = "realtime_thread";
  (session as any).home = "/tmp/openhome-gpt-live-test";
  (session as any).startOptions = { sdp: "v=0\r\n", model: "gpt-test" };
  (session as any).expectResult = async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    if (method === "thread/start") {
      threadNumber += 1;
      return { result: { thread: { id: `task_thread_${threadNumber}` } } };
    }
    if (method === "turn/start") {
      return { result: { turn: { id: `turn_${params.threadId}` } } };
    }
    return { result: {} };
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ChatGPTRealtimeAppServerSession", () => {
  test("rejects spawn failures and removes temporary credentials", async () => {
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123", refreshToken: "refresh" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      command: [`missing-login-with-chatgpt-test-${crypto.randomUUID()}`],
    });

    await expect(session.start({ sdp: "v=0\r\n" })).rejects.toThrow();

    const home = (session as unknown as { home: string }).home;
    await expect(access(join(home, "auth.json"))).rejects.toThrow();
  });

  test("does not pass unrelated server secrets to the app-server process", async () => {
    const secretName = "LWC_APP_SERVER_TEST_SECRET";
    process.env[secretName] = "must-not-leak";
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      command: [
        process.execPath,
        "-e",
        `process.exit(process.env.${secretName} ? 23 : 0)`,
      ],
    });

    try {
      await expect(session.start({ sdp: "v=0\r\n" })).rejects.toThrow();
      expect((session as unknown as { process: { exitCode: number | null } }).process.exitCode).toBe(0);
      const home = (session as unknown as { home: string }).home;
      await expect(access(join(home, "auth.json"))).rejects.toThrow();
    } finally {
      delete process.env[secretName];
    }
  });

  test("preserves the signed ChatGPT plan entitlement", () => {
    const accessToken = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
        chatgpt_plan_type: "pro",
      },
    });

    expect(chatgptPlanType({ accessToken, accountId: "acct_123" })).toBe("pro");
  });

  test("uses the selected model for delegated execution", () => {
    expect(realtimeExecutionConfig({ model: "gpt-5.6-luna" })).toEqual({
      model: "gpt-5.6-luna",
      config: { model_reasoning_effort: "low" },
    });
  });

  test("builds non-stale owner-local clock policy for native Live", () => {
    const context = realtimeClockContext(
      { timezone: "America/New_York", timezoneOffsetMinutes: 240 },
      new Date("2026-08-08T17:23:45.000Z"),
    );
    expect(context).toContain("Authoritative owner IANA timezone: America/New_York");
    expect(context).toContain("live currentTime/read provider");
    expect(context).toContain("Never hand these questions to Codex");
    expect(context).not.toContain("2026-08-08");
    expect(context).not.toContain("1:23");
  });

  test("legacy clock refresh cannot append a response-producing developer item", async () => {
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
    });
    let request: { method: string; params: Record<string, unknown> } | undefined;
    (session as any).threadId = "thread_1";
    (session as any).startOptions = {
      sdp: "v=0\r\n",
      timezone: "America/New_York",
      timezoneOffsetMinutes: 240,
    };
    (session as any).expectResult = async (method: string, params: Record<string, unknown>) => {
      request = { method, params };
      return { result: {} };
    };

    await session.refreshClock();

    expect(request).toBeUndefined();
  });

  test("answers app-server current-time requests from the live owner clock", async () => {
    const wire: Array<Record<string, unknown>> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      now: () => 1_786_212_345_678,
    });
    (session as any).threadId = "thread_1";
    (session as any).send = (message: Record<string, unknown>) => wire.push(message);

    await (session as any).handleServerRequest(17, "currentTime/read", { threadId: "thread_1" });

    expect(wire).toEqual([{ id: 17, result: { currentTimeAt: 1_786_212_345 } }]);
  });

  test("speaks a concrete acknowledgement after a Codex handoff starts", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      handoffAcknowledgement: "Codex started. You can keep talking while it works.",
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => {
      speech.push(text);
    };
    mockStartedSession(session);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: {
        type: "handoff_request",
        input_transcript: "Create a small game.",
      },
    });
    await settle();

    expect(events).toContainEqual({ type: "handoff", transcript: "Create a small game." });
    expect(events).toContainEqual({
      type: "handoff.started",
      taskId: expect.any(String),
      transcript: "Create a small game.",
      activeCount: 1,
    });
    expect(speech).toEqual(["Codex started. You can keep talking while it works."]);
  });

  test("interrupts simple native-only handoffs and retries them without starting Codex", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      handoffAcknowledgement: "Codex started.",
      routeHandoff: (transcript) => transcript.includes("search the web") ? "native" : "codex",
      now: () => 1_000,
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: {
        type: "handoff_request",
        input_transcript: "Juniper, search the web for today's OpenHome news",
      },
    });
    await settle();

    expect(events).toContainEqual({
      type: "handoff.redirected",
      transcript: "Juniper, search the web for today's OpenHome news",
      destination: "native",
    });
    expect(events.some((event) => event.type === "handoff.started")).toBe(false);
    expect(speech).toEqual([]);
    expect(requests.map((request) => request.method)).toEqual([
      "thread/realtime/appendText",
      "thread/realtime/appendText",
    ]);
    expect(requests[1]?.params).toMatchObject({
      role: "user",
      text: "Native-only retry. Do not delegate to Codex: search the web for today's OpenHome news",
    });
  });

  test("routes web handoffs through OpenAI search without starting Codex", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const searched: string[] = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      routeHandoff: (transcript) => transcript.includes("search the web") ? "openai_search" : "codex",
      executeSearch: async (transcript) => {
        searched.push(transcript);
        return "OpenHome released version one point two today, according to GitHub.";
      },
      searchAcknowledgement: "I’m searching OpenAI now.",
      now: () => 1_000,
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: {
        type: "handoff_request",
        input_transcript: "Juniper, search the web for today's OpenHome news",
      },
    });
    await settle();

    expect(searched).toEqual(["search the web for today's OpenHome news"]);
    expect(speech).toEqual([
      "I’m searching OpenAI now.",
      "OpenHome released version one point two today, according to GitHub.",
    ]);
    expect(requests).toEqual([]);
    expect(events.some((event) => event.type === "handoff.started")).toBe(false);
    expect(events.some((event) => event.type === "search.started")).toBe(true);
    expect(events.some((event) => event.type === "search.completed" && event.status === "completed")).toBe(true);
  });

  test("keeps OpenAI search available while a Codex task is running", async () => {
    const speech: string[] = [];
    const searched: string[] = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      routeHandoff: (transcript) => transcript.includes("latest news") ? "openai_search" : "codex",
      executeSearch: async (transcript) => {
        searched.push(transcript);
        return "Here is the current result.";
      },
      handoffAcknowledgement: "Codex started.",
      searchAcknowledgement: "Searching OpenAI.",
      now: () => 1_000,
    });
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Build a game in my workspace." },
    });
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Juniper, search for the latest news" },
    });
    await settle();

    expect(searched).toEqual(["search for the latest news"]);
    expect(speech).toContain("Codex started.");
    expect(speech).toContain("Searching OpenAI.");
    expect(speech).toContain("Here is the current result.");
    expect((session as any).activeTasks.size).toBe(1);
    expect([...(session as any).activeTasks.values()][0]?.transcript).toBe("Build a game in my workspace.");
  });

  test("starts overlapping handoffs in parallel isolated threads and deduplicates retries", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      handoffAcknowledgement: "I started that in a new Codex task.",
      now: () => 1_000,
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Build a game." },
    });
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: {
        type: "handoff_request",
        input_transcript: "Look up OpenHome.",
        active_transcript: [
          { role: "assistant", text: "OpenHome makes an AI speaker." },
          { role: "user", text: "Look up OpenHome." },
        ],
      },
    });
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Look up OpenHome." },
    });

    await settle();

    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
    const turnStarts = requests.filter((request) => request.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts.map((request) => request.params.threadId)).toEqual([
      "task_thread_1",
      "task_thread_2",
    ]);
    expect(JSON.stringify(turnStarts[1]?.params)).toContain("Look up OpenHome.");
    expect(JSON.stringify(turnStarts[1]?.params)).toContain("OpenHome makes an AI speaker.");
    expect(events.some((event) => event.type === "handoff.deduplicated")).toBe(true);
    expect(speech.filter((text) => text === "I started that in a new Codex task.")).toHaveLength(2);

    await (session as any).handleTurnCompleted({
      threadId: "task_thread_1",
      turn: {
        id: "turn_task_thread_1",
        status: "completed",
        items: [{ type: "agentMessage", text: "The first task is complete." }],
      },
    });

    expect(speech).toContain("The first task is complete.");
    expect(events.some((event) => event.type === "handoff.completed" && event.fallbackSpeech)).toBe(true);
    expect((session as any).activeTasks.size).toBe(1);
    expect((session as any).tasksByThreadId.has("task_thread_2")).toBe(true);
  });

  test("speaks the completed turn result when Codex omitted its speech tool", async () => {
    const speech: string[] = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
    });
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session);
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Create a project." },
    });
    await settle();

    await (session as any).handleTurnCompleted({
      threadId: "task_thread_1",
      turn: {
        id: "turn_task_thread_1",
        status: "completed",
        items: [{ type: "agentMessage", text: "Done — I created the project and verified it." }],
      },
    });

    expect(speech.at(-1)).toBe("Done — I created the project and verified it.");
  });

  test("rejects reserved and duplicate dynamic-tool names", () => {
    const base = {
      tokens: { accessToken: "access", accountId: "acct_123" },
      executeTool: async () => ({ output: {} }),
    };
    expect(() => new ChatGPTRealtimeAppServerSession({
      ...base,
      tools: [{
        type: "function",
        name: "speak_to_user",
        description: "reserved",
        inputSchema: {},
      }],
    })).toThrow("reserved");
    expect(() => new ChatGPTRealtimeAppServerSession({
      ...base,
      tools: [{
        type: "function",
        name: "email",
        description: "first",
        inputSchema: {},
      }, {
        type: "function",
        name: "email",
        description: "second",
        inputSchema: {},
      }],
    })).toThrow("Duplicate");
  });

  test("acknowledges speak_to_user before requesting appended speech", async () => {
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
    });
    const order: string[] = [];
    (session as any).threadId = "thread_1";
    (session as any).send = (message: Record<string, unknown>) => {
      order.push(message["id"] === 51 ? "tool-response" : "send");
    };
    (session as any).expectResult = async (method: string) => {
      order.push(method);
      return { result: {} };
    };

    await (session as any).handleTool(51, {
      callId: "call_speak",
      tool: "speak_to_user",
      arguments: { text: "It is noon." },
    });

    expect(order).toEqual(["tool-response", "thread/realtime/appendSpeech"]);
  });

  test("returns pending confirmation without blocking the app-server request", async () => {
    const confirmations: unknown[] = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [{
        type: "function",
        name: "email_request_send_draft",
        description: "Request review before sending a draft.",
        inputSchema: { type: "object" },
      }],
      executeTool: async () => ({
        output: { status: "pending_confirmation", draftId: "draft_1" },
        pendingConfirmation: {
          review: { draftId: "draft_1", to: ["person@example.com"] },
        },
      }),
      confirmTool: async ({ confirmation }) => {
        confirmations.push(confirmation);
        return { output: { status: "sent", draftId: "draft_1" } };
      },
    });
    const wire: Array<Record<string, unknown>> = [];
    const events: RealtimeBridgeEvent[] = [];
    session.onEvent((event) => events.push(event));
    (session as any).send = (message: Record<string, unknown>) => wire.push(message);

    await (session as any).handleTool(41, {
      callId: "call_1",
      tool: "email_request_send_draft",
      arguments: { draftId: "draft_1" },
    });

    expect(wire).toHaveLength(1);
    expect(wire[0]?.id).toBe(41);
    expect((wire[0]?.result as Record<string, unknown>)?.success).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "tool.pending_confirmation",
      callId: "call_1",
      name: "email_request_send_draft",
      review: { draftId: "draft_1", to: ["person@example.com"] },
    });

    const confirmed = await session.resolveConfirmation("call_1", { approved: true });

    expect(confirmations).toEqual([{ approved: true }]);
    expect(confirmed).toEqual({ output: { status: "sent", draftId: "draft_1" } });
    expect(wire).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: "tool.completed",
      callId: "call_1",
      name: "email_request_send_draft",
    });
  });

  test("claims confirmation atomically and prevents duplicate execution", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let confirmations = 0;
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [{
        type: "function",
        name: "apply_change",
        description: "Apply a pending change after confirmation.",
        inputSchema: { type: "object" },
      }],
      executeTool: async () => ({
        output: { status: "pending_confirmation" },
        pendingConfirmation: { review: { changeId: "change_1" } },
      }),
      confirmTool: async () => {
        confirmations += 1;
        await gate;
        return { output: { status: "applied" } };
      },
    });
    (session as any).send = () => {};
    await (session as any).handleTool(1, {
      callId: "call_1",
      tool: "apply_change",
      arguments: {},
    });

    const first = session.resolveConfirmation("call_1", { approved: true });
    await expect(
      session.resolveConfirmation("call_1", { approved: true }),
    ).rejects.toThrow("no longer pending");
    release();
    await first;
    expect(confirmations).toBe(1);
  });

  test("restores a pending confirmation after an application failure", async () => {
    let attempts = 0;
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [{
        type: "function",
        name: "apply_change",
        description: "Apply a pending change after confirmation.",
        inputSchema: { type: "object" },
      }],
      executeTool: async () => ({
        output: { status: "pending_confirmation" },
        pendingConfirmation: { review: { changeId: "change_1" } },
      }),
      confirmTool: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
        return { output: { status: "applied" } };
      },
    });
    (session as any).send = () => {};
    await (session as any).handleTool(1, {
      callId: "call_1",
      tool: "apply_change",
      arguments: {},
    });

    await expect(
      session.resolveConfirmation("call_1", { approved: true }),
    ).rejects.toThrow("temporary failure");
    await expect(
      session.resolveConfirmation("call_1", { approved: true }),
    ).resolves.toMatchObject({ output: { status: "applied" } });
    expect(attempts).toBe(2);
  });

  test("does not turn a completed confirmation into a failure when speech fails", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [{
        type: "function",
        name: "apply_change",
        description: "Apply a pending change after confirmation.",
        inputSchema: { type: "object" },
      }],
      executeTool: async () => ({
        output: { status: "pending_confirmation" },
        pendingConfirmation: { review: { changeId: "change_1" } },
      }),
      confirmTool: async () => ({
        output: { status: "applied" },
        speech: "The change was applied.",
      }),
    });
    (session as any).send = () => {};
    (session as any).threadId = "thread_1";
    (session as any).expectResult = async () => {
      throw new Error("voice transport closed");
    };
    session.onEvent((event) => events.push(event));
    await (session as any).handleTool(1, {
      callId: "call_1",
      tool: "apply_change",
      arguments: {},
    });

    await expect(
      session.resolveConfirmation("call_1", { approved: true }),
    ).resolves.toEqual({
      output: { status: "applied" },
      speech: "The change was applied.",
    });
    expect(events).toContainEqual({
      type: "error",
      message: "Confirmation completed, but its spoken acknowledgement failed.",
    });
    expect(events.at(-1)).toEqual({
      type: "tool.completed",
      callId: "call_1",
      name: "apply_change",
    });
  });
});
