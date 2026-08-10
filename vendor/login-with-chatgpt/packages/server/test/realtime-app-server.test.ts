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

  test("acknowledges a Codex handoff before slow task-thread startup", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    let releaseThreadStart!: () => void;
    const threadStartGate = new Promise<void>((resolve) => {
      releaseThreadStart = resolve;
    });
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      handoffAcknowledgement: "Starting that now.",
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session);
    const originalExpectResult = (session as any).expectResult.bind(session);
    (session as any).expectResult = async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/start") await threadStartGate;
      return originalExpectResult(method, params);
    };

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: {
        type: "handoff_request",
        input_transcript: "Play The Office in Helium.",
      },
    });
    await settle();

    expect(speech).toEqual(["Starting that now."]);
    expect(events).toContainEqual({
      type: "handoff.started",
      taskId: expect.any(String),
      transcript: "Play The Office in Helium.",
      activeCount: 1,
    });
    expect((session as any).activeTasks.size).toBe(1);

    releaseThreadStart();
    await settle();
  });

  test("retries one native-only handoff and silently suppresses repeated fallback loops", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      handoffAcknowledgement: "Codex started.",
      routeHandoff: () => "native",
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
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: {
        type: "handoff_request",
        input_transcript: "Tell me today's OpenHome news instead",
      },
    });
    await settle();

    expect(events).toContainEqual({
      type: "handoff.redirected",
      transcript: "search the web for today's OpenHome news",
      destination: "native",
    });
    expect(events).toContainEqual({
      type: "handoff.deduplicated",
      transcript: "Tell me today's OpenHome news instead",
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
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: {
        type: "handoff_request",
        input_transcript: "search the web for today's OpenHome news",
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
    expect(events.filter((event) => event.type === "handoff.deduplicated")).toHaveLength(1);
  });

  test("routes routine Spotify handoffs without starting Codex and shares the idempotency id", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const executed: Array<{ transcript: string; requestId: string; speechCount: number }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      routeHandoff: () => "spotify",
      spotifyAcknowledgement: "Starting that on Spotify now.",
      executeSpotify: async (transcript, requestId) => {
        executed.push({ transcript, requestId, speechCount: speech.length });
        return "Dreams by Fleetwood Mac is playing.";
      },
      now: () => 1_000,
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play Dreams by Fleetwood Mac." },
    });
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play Dreams by Fleetwood Mac." },
    });
    await settle();

    const started = events.find((event) => event.type === "spotify.started");
    expect(started?.type).toBe("spotify.started");
    expect(executed).toEqual([{
      transcript: "Play Dreams by Fleetwood Mac.",
      requestId: started?.type === "spotify.started" ? started.taskId : "",
      speechCount: 1,
    }]);
    expect(speech).toEqual([
      "Starting that on Spotify now.",
      "Dreams by Fleetwood Mac is playing.",
    ]);
    expect(events.some((event) => event.type === "spotify.completed" && event.status === "completed")).toBe(true);
    expect(events.filter((event) => event.type === "handoff.deduplicated")).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  test("uses music as the completion signal instead of repeating playback success", async () => {
    const speech: string[] = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      routeHandoff: () => "spotify",
      spotifyAcknowledgement: "Got it. Starting Spotify.",
      executeSpotify: async () => ({
        speech: "Get Lucky by Daft Punk is playing.",
        speakCompletion: false,
      }),
    });
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, []);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play Get Lucky by Daft Punk." },
    });
    await settle();

    expect(speech).toEqual(["Got it. Starting Spotify."]);
  });

  test("claims a locally transcribed Spotify turn and interrupts the native duplicate", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const executed: string[] = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      routeHandoff: (transcript) => transcript.includes("Spotify") ? "spotify" : "codex",
      executeSpotify: async (transcript) => {
        executed.push(transcript);
        return "Playback started.";
      },
    });
    (session as any).speak = async () => {};
    mockStartedSession(session, requests);
    (session as any).startOptions.wakePhrase = "lara";
    (session as any).handleNotification("turn/started", {
      threadId: "realtime_thread",
      turn: { id: "native_turn_1" },
    });

    await expect(session.submitExternalVoiceCommand(
      "voice_turn_0004",
      "Lara, play Dreams on Spotify.",
    )).resolves.toBe("accepted");
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play Dreams on Spotify." },
    });
    await settle();

    expect(requests[0]).toEqual({
      method: "turn/interrupt",
      params: { threadId: "realtime_thread", turnId: "native_turn_1" },
    });
    expect(executed).toEqual(["play Dreams on Spotify."]);
  });

  test("ignores local transcripts outside the Spotify lane", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      routeHandoff: () => "codex",
    });
    mockStartedSession(session, requests);

    await expect(session.submitExternalVoiceCommand(
      "voice_turn_0005",
      "Explain photosynthesis.",
    )).resolves.toBe("ignored");
    expect(requests).toEqual([]);
  });

  test("allows exactly one backend route for each physical wake transaction", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const searched: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      routeHandoff: (transcript) => transcript.includes("news") ? "openai_search" : "codex",
      executeSearch: async (transcript) => {
        searched.push(transcript);
        return "Current news result.";
      },
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async () => {};
    mockStartedSession(session, requests);

    session.beginVoiceTurn("voice_turn_0001");
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play one song on YouTube." },
    });
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Search for that song in the news." },
    });
    await settle();

    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    expect(searched).toEqual([]);
    expect(events.filter((event) => event.type === "handoff.deduplicated")).toHaveLength(1);

    session.beginVoiceTurn("voice_turn_0002");
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Search the news for OpenHome." },
    });
    await settle();

    expect(searched).toEqual(["Search the news for OpenHome."]);
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
    expect(JSON.stringify(turnStarts[1]?.params)).not.toContain("OpenHome makes an AI speaker.");
    expect(JSON.stringify(turnStarts[1]?.params)).toContain("exact current user request");
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

  test("keeps media playback single-flight and gives it a no-duplicate browser contract", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      now: () => 1_000,
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async () => {};
    mockStartedSession(session, requests);
    (session as any).startOptions.wakePhrase = "lara";

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Lara, play Midnight City on YouTube." },
    });
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play the song Midnight City in YouTube." },
    });
    await settle();

    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    const turnStart = requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params)).toContain('kind=\\"media\\"');
    expect(JSON.stringify(turnStart?.params)).not.toContain("Lara,");
    expect(JSON.stringify(turnStart?.params)).toContain("Open at most one new tab and one media stream");
    expect(events.filter((event) => event.type === "handoff.deduplicated")).toHaveLength(1);
  });

  test("does not classify non-media play requests as media", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
    });
    (session as any).speak = async () => {};
    mockStartedSession(session, requests);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play chess in Chrome." },
    });
    await settle();

    const turnStart = requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params)).toContain('kind=\\"computer\\"');
    expect(JSON.stringify(turnStart?.params)).not.toContain("Media playback contract");
  });

  test("does not reserve the media replay guard when task capacity rejects a request", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      now: () => 1_000,
    });
    (session as any).speak = async () => {};
    mockStartedSession(session, requests);
    for (let index = 0; index < 4; index += 1) {
      (session as any).activeTasks.set(`busy_${index}`, { id: `busy_${index}`, kind: "general" });
    }

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play one song on YouTube." },
    });
    (session as any).activeTasks.clear();
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play one song on YouTube." },
    });
    await settle();

    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
  });

  test("starts the hard deadline before delegated thread startup", async () => {
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      mediaTaskTimeoutMs: 5,
    });
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);
    (session as any).expectResult = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { result: { thread: { id: "late_thread" } } };
      }
      return { result: { turn: { id: "late_turn" } } };
    };

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play one song on YouTube." },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
    expect((session as any).activeTasks.size).toBe(0);
    expect(speech.at(-1)).toContain("stopped it before it could keep clicking or open duplicates");
  });

  test("treats completion speech as terminal and interrupts further computer use", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const wire: Array<Record<string, unknown>> = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => speech.push(text);
    (session as any).send = (message: Record<string, unknown>) => wire.push(message);
    mockStartedSession(session, requests);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Open the trailer in Helium." },
    });
    await settle();
    await (session as any).handleTool(51, {
      callId: "call_speak",
      threadId: "task_thread_1",
      turnId: "turn_task_thread_1",
      tool: "speak_to_user",
      arguments: { text: "The trailer is playing." },
    });

    expect(speech).toEqual(["The trailer is playing."]);
    expect((session as any).activeTasks.size).toBe(0);
    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "task_thread_1", turnId: "turn_task_thread_1" },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "handoff.completed",
      status: "completed",
      fallbackSpeech: false,
      activeCount: 0,
    }));

    await (session as any).handleTool(52, {
      callId: "call_late",
      threadId: "task_thread_1",
      turnId: "turn_task_thread_1",
      tool: "speak_to_user",
      arguments: { text: "I opened another tab." },
    });
    expect(speech).toEqual(["The trailer is playing."]);
    expect(wire.at(-1)?.["result"]).toEqual(expect.objectContaining({ success: true }));
  });

  test("stops a media task as soon as its tool result confirms active playback", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play Midnight City on YouTube." },
    });
    await settle();
    (session as any).handleNotification("item/completed", {
      threadId: "task_thread_1",
      turnId: "turn_task_thread_1",
      item: {
        type: "mcpToolCall",
        server: "computer-use",
        tool: "computer",
        result: { content: [{ type: "text", text: "button Pause (k)" }] },
      },
    });
    await settle();

    expect((session as any).activeTasks.size).toBe(0);
    expect(speech.at(-1)).toBe("Playback started.");
    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "task_thread_1", turnId: "turn_task_thread_1" },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "handoff.completed",
      status: "completed",
      fallbackSpeech: false,
    }));
  });

  test("interrupts an exact repeated computer action before a second execution", async () => {
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
    });
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play a song on YouTube." },
    });
    await settle();

    const repeated = {
      threadId: "task_thread_1",
      turnId: "turn_task_thread_1",
      item: {
        type: "mcpToolCall",
        server: "computer-use",
        tool: "computer",
        arguments: { action: "click", x: 400, y: 300 },
      },
    };
    (session as any).handleNotification("item/started", repeated);
    (session as any).handleNotification("item/started", repeated);
    await settle();

    expect((session as any).activeTasks.size).toBe(0);
    expect(speech.at(-1)).toContain("repeat the same computer action");
  });

  test("interrupts a media task that exceeds its hard deadline", async () => {
    const events: RealtimeBridgeEvent[] = [];
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
      mediaTaskTimeoutMs: 5,
    });
    session.onEvent((event) => events.push(event));
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);

    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play a song on YouTube." },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((session as any).activeTasks.size).toBe(0);
    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "task_thread_1", turnId: "turn_task_thread_1" },
    });
    expect(speech.at(-1)).toContain("stopped it before it could keep clicking or open duplicates");
    expect(events).toContainEqual(expect.objectContaining({
      type: "handoff.completed",
      status: "interrupted",
      activeCount: 0,
    }));
  });

  test("interrupts a media task that loops through too many computer actions", async () => {
    const speech: string[] = [];
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = new ChatGPTRealtimeAppServerSession({
      tokens: { accessToken: "access", accountId: "acct_123" },
      tools: [],
      executeTool: async () => ({ output: {} }),
    });
    (session as any).speak = async (text: string) => speech.push(text);
    mockStartedSession(session, requests);
    (session as any).handleNotification("thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "Play a song on YouTube." },
    });
    await settle();

    for (let index = 0; index < 13; index += 1) {
      (session as any).handleNotification("item/started", {
        threadId: "task_thread_1",
        turnId: "turn_task_thread_1",
        item: {
          id: `computer_${index}`,
          type: "mcpToolCall",
          server: "computer-use",
          tool: "computer",
          arguments: { action: "click", x: index, y: index },
        },
      });
    }
    await settle();

    expect((session as any).activeTasks.size).toBe(0);
    expect(speech.at(-1)).toContain("safe interaction limit");
    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "task_thread_1", turnId: "turn_task_thread_1" },
    });
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
