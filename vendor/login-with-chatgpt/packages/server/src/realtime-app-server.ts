import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChatGPTTokens, ReasoningEffort } from "@opencoredev/loginwithchatgpt-core";

export interface RealtimeDynamicTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RealtimeToolContext {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface RealtimeToolResult {
  /** JSON-serializable structured result returned to the execution agent. */
  output: unknown;
  /** Keep the action pending in application UI until `resolveConfirmation()` is called. */
  pendingConfirmation?: {
    /** Safe review payload sent to the browser status stream. */
    review: unknown;
  };
}

export interface RealtimeConfirmationResult {
  /** Application result returned by `resolveConfirmation()` to direct server-side callers. */
  output: unknown;
  /** Optional short acknowledgement spoken through the native Live session. */
  speech?: string;
}

export type RealtimeBridgeEvent =
  | { type: "session.started" }
  | { type: "session.closed" }
  | { type: "handoff"; transcript: string }
  | { type: "handoff.started"; taskId: string; transcript: string; queued: boolean }
  | { type: "handoff.queued"; taskId: string; transcript: string; position: number }
  | { type: "handoff.deduplicated"; transcript: string }
  | { type: "handoff.redirected"; transcript: string; destination: "native" }
  | {
    type: "handoff.completed";
    taskId: string;
    transcript: string;
    status: "completed" | "failed" | "interrupted";
    fallbackSpeech: boolean;
  }
  | { type: "tool.running"; callId: string; name: string }
  | { type: "tool.completed"; callId: string; name: string }
  | { type: "tool.pending_confirmation"; callId: string; name: string; review: unknown }
  | { type: "tool.failed"; callId?: string; name?: string; message: string }
  | { type: "error"; message: string };

export interface ChatGPTRealtimeAppServerOptions {
  tokens: ChatGPTTokens;
  refreshTokens?: () => Promise<ChatGPTTokens>;
  tools: readonly RealtimeDynamicTool[];
  executeTool: (context: RealtimeToolContext) => Promise<RealtimeToolResult>;
  /**
   * Called only after the application receives an explicit confirmation.
   * `confirmation` is application-defined (for example `{ approved: true }`).
   */
  confirmTool?: (
    context: RealtimeToolContext & { confirmation: unknown; pending: RealtimeToolResult },
  ) => Promise<RealtimeConfirmationResult>;
  /** Defaults to the `codex` executable on PATH. */
  command?: readonly string[];
  executionInstructions?: string;
  realtimePrompt?: string;
  /** Spoken immediately after Codex accepts a native Live handoff. */
  handoffAcknowledgement?: string | ((transcript: string) => string | undefined);
  /**
   * Routes an incoming native handoff. Returning `native` interrupts the
   * automatically-created Codex turn and retries the request in GPT Live.
   */
  routeHandoff?: (transcript: string) => "codex" | "native";
  cwd?: string;
  /** Defaults to read-only. Use workspace-write only for an explicitly scoped cwd. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Injectable owner clock for deterministic integrations and tests. */
  now?: () => number;
}

export interface StartRealtimeAppServerOptions {
  sdp: string;
  voice?: string;
  /** IANA timezone used for native date/time context. Defaults to the server timezone. */
  timezone?: string;
  /** JavaScript-style UTC offset in minutes (`Date#getTimezoneOffset`). */
  timezoneOffsetMinutes?: number;
  /**
   * Model used for delegated execution turns. Pass the signed-in user's
   * selected Codex model (for example `gpt-5.6-luna`) so app-server applies
   * the matching model entitlement and quota.
   */
  model?: string;
  /** Defaults to `low` for responsive voice-tool turns. */
  reasoningEffort?: ReasoningEffort;
}

type JsonObject = Record<string, unknown>;

interface PendingConfirmation {
  context: RealtimeToolContext;
  result: RealtimeToolResult;
}

interface DelegatedTask {
  id: string;
  transcript: string;
  normalizedTranscript: string;
  context?: string;
  queued: boolean;
  turnId?: string;
  spoke: boolean;
  contaminated: boolean;
}

interface NativeHandoffRedirect {
  transcript: string;
  retry: boolean;
}

const SPEAK_TOOL = "speak_to_user";
const MAX_QUEUED_HANDOFFS = 5;
const HANDOFF_DEDUPE_MS = 30_000;
const DEFAULT_EXECUTION_INSTRUCTIONS =
  "You are the execution side of one native realtime voice assistant. Requests arrive inside " +
  "<realtime_delegation>. Use dynamic tools whenever private data or an external action is needed. " +
  "After completing a request, call speak_to_user exactly once with a concise result. Never claim " +
  "a tool is unavailable before calling it. Consequential actions may wait for on-screen confirmation.";
const DEFAULT_REALTIME_PROMPT =
  "You are the native realtime voice surface of one assistant. Keep speech natural, concise, and " +
  "interruptible. Answer ordinary conversation directly. For requests requiring tools, private data, " +
  "or actions, use the native backend handoff to the execution agent.";

/**
 * Node/Bun app-server bridge matching the ChatGPT desktop Realtime protocol.
 *
 * WebRTC audio remains browser-to-OpenAI. This process mediates only native
 * `handoff_request` items, dynamic tools, confirmations, and spoken results.
 */
export class ChatGPTRealtimeAppServerSession {
  readonly id = crypto.randomUUID();

  private readonly options: ChatGPTRealtimeAppServerOptions;
  private readonly listeners = new Set<(event: RealtimeBridgeEvent) => void>();
  private process?: ChildProcessWithoutNullStreams;
  private processStopped = false;
  private closePromise?: Promise<void>;
  private home?: string;
  private threadId?: string;
  private startOptions?: StartRealtimeAppServerOptions;
  private requestId = 0;
  private closed = false;
  private pendingRequests = new Map<string | number, {
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private notificationWaiters = new Map<string, Array<{
    resolve: (params: JsonObject) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>();
  private confirmations = new Map<string, PendingConfirmation>();
  private allowedTools: Set<string>;
  private activeTask?: DelegatedTask;
  private queuedTasks: DelegatedTask[] = [];
  private recentHandoffs = new Map<string, number>();
  private recentNativeRedirects = new Map<string, number>();
  private pendingNativeRedirect?: NativeHandoffRedirect;
  private speechTail: Promise<void> = Promise.resolve();

  constructor(options: ChatGPTRealtimeAppServerOptions) {
    if (!options.tokens.accessToken || !options.tokens.accountId) {
      throw new TypeError("App-server Realtime requires accessToken and accountId.");
    }
    this.allowedTools = new Set();
    for (const tool of options.tools) {
      if (!tool.name || tool.name === SPEAK_TOOL) {
        throw new TypeError(`Dynamic tool name "${tool.name}" is reserved or invalid.`);
      }
      if (this.allowedTools.has(tool.name)) {
        throw new TypeError(`Duplicate dynamic tool name: ${tool.name}`);
      }
      this.allowedTools.add(tool.name);
    }
    this.options = options;
  }

  async start(options: StartRealtimeAppServerOptions): Promise<string> {
    if (!options.sdp.trim()) throw new TypeError("`sdp` must be a non-empty WebRTC offer.");
    if (this.process) throw new Error("Realtime app-server session has already started.");
    this.startOptions = { ...options };
    const command = this.options.command ?? [
      "codex", "--enable", "realtime_conversation", "app-server", "--stdio",
    ];
    const [executable, ...args] = command;
    if (!executable) throw new TypeError("App-server command cannot be empty.");
    const home = join(tmpdir(), `login-with-chatgpt-live-${this.id}`);
    await mkdir(home, { recursive: false, mode: 0o700 });
    this.home = home;

    try {
      await this.writeAuth(this.options.tokens);
      this.process = spawn(executable, args, {
        cwd: this.options.cwd ?? home,
        env: appServerEnvironment(home),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process.once("error", (error) => this.handleProcessStop(error));
      this.process.once("exit", () => this.handleProcessStop(new Error("Codex app-server stopped.")));
      this.process.stdin.on("error", (error) => this.handleProcessStop(error));
      createInterface({ input: this.process.stdout }).on("line", (line) => this.handleLine(line));
      createInterface({ input: this.process.stderr }).on("line", () => {
        // Deliberately avoid forwarding stderr: it may contain application context.
      });

      await this.expectResult("initialize", {
        clientInfo: { name: "codex_desktop", title: "Codex Desktop", version: "1" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: true,
          mcpServerOpenaiFormElicitation: true,
          optOutNotificationMethods: [],
        },
      });
      this.notify("initialized", {});
      const thread = await this.expectResult("thread/start", {
        cwd: this.options.cwd ?? home,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: this.options.sandbox ?? "read-only",
        threadSource: "realtime_voice",
        baseInstructions: this.options.executionInstructions ?? DEFAULT_EXECUTION_INSTRUCTIONS,
        developerInstructions: this.options.executionInstructions ?? DEFAULT_EXECUTION_INSTRUCTIONS,
        dynamicTools: [...this.options.tools, speakToolSpec()],
        ...realtimeExecutionConfig(options),
      });
      const threadValue = asRecord(asRecord(thread["result"])?.["thread"]);
      if (typeof threadValue?.["id"] !== "string") throw new Error("App-server returned no thread id.");
      this.threadId = threadValue["id"];

      const [, notification] = await Promise.all([
        this.expectResult("thread/realtime/start", {
          threadId: this.threadId,
          outputModality: "audio",
          clientManagedHandoffs: false,
          // Newer V3 app-servers suppress their vague built-in "checking"
          // filler; this bridge supplies a concrete acknowledgement after the
          // Codex handoff has actually been accepted. Older versions safely
          // ignore this forward-compatible field.
          delegationAckFiller: false,
          flushTranscriptTailOnSessionEnd: true,
          codexResponsesAsItems: false,
          includeStartupContext: true,
          initialItems: [{
            role: "developer",
            text: realtimeClockContext(options, new Date(this.nowMs())),
          }],
          prompt: this.options.realtimePrompt ?? DEFAULT_REALTIME_PROMPT,
          transport: { type: "webrtc", sdp: options.sdp },
          version: "v3",
          voice: options.voice ?? "juniper",
        }, 45_000),
        this.waitForNotification("thread/realtime/sdp", 30_000),
      ]);
      const answer = notification["sdp"];
      if (typeof answer !== "string" || !answer.trimStart().startsWith("v=0")) {
        throw new Error("App-server returned an invalid SDP answer.");
      }
      this.emit({ type: "session.started" });
      return answer;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  onEvent(listener: (event: RealtimeBridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolves an application-owned pending action. The dynamic-tool request has
   * already completed with a pending result, so native Live remains responsive
   * while the UI waits. The bridge never assumes approval from speech.
   */
  async resolveConfirmation(
    callId: string,
    confirmation: unknown,
  ): Promise<RealtimeConfirmationResult> {
    const pending = this.confirmations.get(callId);
    if (!pending) throw new Error("Tool confirmation is no longer pending.");
    if (!this.options.confirmTool) throw new Error("No confirmTool handler is configured.");
    // Claim before awaiting so duplicate clicks or requests cannot execute the
    // consequential action twice. Restore only when the application handler
    // fails and it is safe for the UI to retry.
    this.confirmations.delete(callId);
    let confirmed: RealtimeConfirmationResult;
    try {
      confirmed = await this.options.confirmTool({
        ...pending.context,
        confirmation,
        pending: pending.result,
      });
    } catch (error) {
      this.confirmations.set(callId, pending);
      throw error;
    }
    if (confirmed.speech) {
      try {
        await this.speak(confirmed.speech);
      } catch {
        this.emit({
          type: "error",
          message: "Confirmation completed, but its spoken acknowledgement failed.",
        });
      }
    }
    this.emit({ type: "tool.completed", callId, name: pending.context.name });
    return confirmed;
  }

  async speak(text: string): Promise<void> {
    const speech = text.trim();
    if (!this.threadId || !speech) return;
    const operation = this.speechTail.catch(() => {}).then(async () => {
      await this.expectResult("thread/realtime/appendSpeech", {
        threadId: this.threadId,
        text: speech,
      });
    });
    this.speechTail = operation.catch(() => {});
    await operation;
  }

  /** Refresh the native model's authoritative clock without starting a Codex handoff. */
  async refreshClock(): Promise<void> {
    if (!this.threadId || !this.startOptions) throw new Error("Realtime session is not running.");
    await this.expectResult("thread/realtime/appendText", {
      threadId: this.threadId,
      role: "developer",
      text: realtimeClockContext(this.startOptions, new Date(this.nowMs())),
    });
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeInternal();
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    try {
      if (this.threadId && this.process?.exitCode === null) {
        await this.expectResult("thread/realtime/stop", { threadId: this.threadId }, 5_000).catch(() => {});
      }
      try {
        this.process?.stdin.end();
      } catch {
        // The process may already have failed; cleanup must still continue.
      }
      if (this.process?.pid && isProcessRunning(this.process)) {
        const process = this.process;
        if (!await waitForProcessExit(process, 2_000)) {
          process.kill("SIGTERM");
          if (!await waitForProcessExit(process, 2_000)) process.kill("SIGKILL");
        }
      }
    } finally {
      this.rejectPending(new Error("Codex app-server session closed."));
      try {
        if (this.home) await rm(this.home, { recursive: true, force: true });
      } finally {
        this.emit({ type: "session.closed" });
      }
    }
  }

  private async writeAuth(tokens: ChatGPTTokens): Promise<void> {
    if (!this.home) return;
    await writeFile(join(this.home, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: new Date().toISOString(),
      OPENAI_API_KEY: null,
      tokens: {
        access_token: tokens.accessToken,
        account_id: tokens.accountId,
        id_token: tokens.idToken ?? null,
        refresh_token: tokens.refreshToken ?? null,
      },
    }), { mode: 0o600 });
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    const id = message["id"];
    if ((typeof id === "string" || typeof id === "number") &&
        ("result" in message || "error" in message) && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.resolve(message);
      return;
    }
    const method = message["method"];
    if (typeof method !== "string") return;
    const params = asRecord(message["params"]) ?? {};
    const waiters = this.notificationWaiters.get(method) ?? [];
    this.notificationWaiters.delete(method);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(params);
    }
    if (typeof id === "string" || typeof id === "number") {
      void this.handleServerRequest(id, method, params).catch((error) => {
        this.handleProcessStop(error instanceof Error ? error : new Error(String(error)));
      });
    } else {
      this.handleNotification(method, params);
    }
  }

  private async handleServerRequest(
    id: string | number,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    try {
      if (method === "attestation/generate") {
        this.send({ id, result: { token: unsupportedAttestationToken() } });
        return;
      }
      if (method === "account/chatgptAuthTokens/refresh") {
        const tokens = await this.options.refreshTokens?.();
        if (!tokens?.accessToken || !tokens.accountId) throw new Error("Token refresh is unavailable.");
        await this.writeAuth(tokens);
        this.send({
          id,
          result: {
            accessToken: tokens.accessToken,
            chatgptAccountId: tokens.accountId,
            chatgptPlanType: chatgptPlanType(tokens),
          },
        });
        return;
      }
      if (method === "currentTime/read") {
        if (typeof params["threadId"] !== "string" || params["threadId"] !== this.threadId) {
          throw new Error("Current-time request does not belong to this realtime thread.");
        }
        this.send({ id, result: { currentTimeAt: Math.floor(this.nowMs() / 1_000) } });
        return;
      }
      if (method !== "item/tool/call") {
        this.send({ id, error: { code: -32601, message: `Unsupported request: ${method}` } });
        return;
      }
      await this.handleTool(id, params);
    } catch {
      const message = method === "item/tool/call"
        ? "Realtime tool execution failed."
        : "Realtime app-server request failed.";
      if (method === "item/tool/call") {
        this.send({ id, result: dynamicToolResponse({ status: "error", message }, false) });
      } else {
        this.send({ id, error: { code: -32000, message } });
      }
      if (method === "item/tool/call") {
        this.emit({
          type: "tool.failed",
          callId: typeof params["callId"] === "string" ? params["callId"] : undefined,
          name: typeof params["tool"] === "string" ? params["tool"] : undefined,
          message,
        });
      } else {
        this.emit({ type: "error", message });
      }
    }
  }

  private async handleTool(id: string | number, params: JsonObject): Promise<void> {
    const callId = params["callId"];
    const name = params["tool"];
    const args = asRecord(params["arguments"]);
    if (typeof callId !== "string" || typeof name !== "string" || !args) {
      throw new Error("App-server returned an invalid dynamic-tool request.");
    }
    if (name !== SPEAK_TOOL && !this.allowedTools.has(name)) {
      throw new Error(`App-server requested an unregistered dynamic tool: ${name}`);
    }
    const context = { callId, name, arguments: args };
    this.emit({ type: "tool.running", callId, name });
    if (name === SPEAK_TOOL) {
      const text = args["text"];
      if (typeof text !== "string" || !text.trim()) throw new Error("speak_to_user requires text.");
      const task = this.activeTask;
      if (task?.spoke) {
        this.send({ id, result: dynamicToolResponse({ status: "already_spoken" }) });
        this.emit({ type: "tool.completed", callId, name });
        return;
      }
      // Realtime currently steers a second handoff into an already-running
      // Codex turn. Do not let the steered request replace the first task's
      // completion speech. The bridge will run that queued request separately.
      if (task?.contaminated) {
        this.send({ id, result: dynamicToolResponse({ status: "deferred_to_task_queue" }) });
        this.emit({ type: "tool.completed", callId, name });
        return;
      }
      if (task) task.spoke = true;
      // Acknowledge the server-initiated tool call before sending another
      // client request to that same app-server process. Some app-server
      // versions serialize these messages; awaiting appendSpeech first makes
      // each side wait on the other forever and wedges the Live conversation.
      this.send({ id, result: dynamicToolResponse({ status: "spoken" }) });
      await this.speak(text);
      this.emit({ type: "tool.completed", callId, name });
      return;
    }
    const result = await this.options.executeTool(context);
    if (result.pendingConfirmation) {
      if (!this.options.confirmTool) throw new Error("Tool requested confirmation without confirmTool.");
      if (this.confirmations.has(callId)) throw new Error("Tool confirmation call id is already pending.");
      assertJsonSerializable(result.pendingConfirmation.review, "Confirmation review");
      // A JSON-RPC request left open blocks subsequent realtime handoffs and
      // wedges the native session in "thinking". Return the structured pending
      // result now; only the consequential application action stays gated.
      this.send({ id, result: dynamicToolResponse(result.output) });
      this.confirmations.set(callId, { context, result });
      this.emit({
        type: "tool.pending_confirmation",
        callId,
        name,
        review: result.pendingConfirmation.review,
      });
      return;
    }
    this.send({ id, result: dynamicToolResponse(result.output) });
    this.emit({ type: "tool.completed", callId, name });
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === "thread/realtime/itemAdded") {
      const item = asRecord(params["item"]);
      if (item?.["type"] === "handoff_request") {
        this.handleHandoff(item);
      }
    } else if (method === "turn/started") {
      const turn = asRecord(params["turn"]);
      if (this.pendingNativeRedirect && typeof turn?.["id"] === "string") {
        const redirect = this.pendingNativeRedirect;
        this.pendingNativeRedirect = undefined;
        void this.completeNativeRedirect(turn["id"], redirect).catch(() => this.emit({
          type: "error",
          message: "The native GPT Live search retry failed.",
        }));
      } else if (this.activeTask && !this.activeTask.turnId && typeof turn?.["id"] === "string") {
        this.activeTask.turnId = turn["id"];
      }
    } else if (method === "turn/completed") {
      void this.handleTurnCompleted(params).catch(() => this.emit({
        type: "error",
        message: "Codex finished, but task completion handling failed.",
      }));
    } else if (method === "thread/realtime/error") {
      this.emit({ type: "error", message: "The Realtime service reported an error." });
    } else if (method === "thread/realtime/closed") {
      void this.close().catch(() => this.emit({ type: "error", message: "Realtime cleanup failed." }));
    }
  }

  private handleHandoff(item: JsonObject): void {
    const transcript = (typeof item["input_transcript"] === "string"
      ? item["input_transcript"]
      : typeof item["input"] === "string"
        ? item["input"]
        : "").trim();
    if (!transcript) return;
    const normalizedTranscript = normalizeTranscript(transcript);
    const now = this.nowMs();
    for (const [key, seenAt] of this.recentHandoffs) {
      if (now - seenAt >= HANDOFF_DEDUPE_MS) this.recentHandoffs.delete(key);
    }
    for (const [key, seenAt] of this.recentNativeRedirects) {
      if (now - seenAt >= HANDOFF_DEDUPE_MS) this.recentNativeRedirects.delete(key);
    }
    if (this.options.routeHandoff?.(transcript) === "native") {
      const redirectKey = nativeRedirectKey(transcript);
      const retry = !this.recentNativeRedirects.has(redirectKey);
      this.recentNativeRedirects.set(redirectKey, now);
      this.emit({ type: "handoff.redirected", transcript, destination: "native" });
      if (this.activeTask) {
        void this.retryNativeHandoff(transcript, retry).catch(() => this.emit({
          type: "error",
          message: "The native GPT Live search retry failed.",
        }));
      } else {
        this.pendingNativeRedirect = { transcript, retry };
      }
      return;
    }
    if (
      this.activeTask?.normalizedTranscript === normalizedTranscript
      || this.queuedTasks.some((task) => task.normalizedTranscript === normalizedTranscript)
      || this.recentHandoffs.has(normalizedTranscript)
    ) {
      this.emit({ type: "handoff.deduplicated", transcript });
      return;
    }
    this.recentHandoffs.set(normalizedTranscript, now);
    const task: DelegatedTask = {
      id: crypto.randomUUID(),
      transcript,
      normalizedTranscript,
      context: handoffContext(item),
      queued: Boolean(this.activeTask),
      spoke: false,
      contaminated: false,
    };
    this.emit({ type: "handoff", transcript });

    if (!this.activeTask) {
      this.activeTask = task;
      this.emit({ type: "handoff.started", taskId: task.id, transcript, queued: false });
      this.acknowledgeHandoff(transcript);
      this.publishTaskState();
      return;
    }

    this.activeTask.contaminated = !this.activeTask.spoke;
    if (this.queuedTasks.length >= MAX_QUEUED_HANDOFFS) {
      void this.speak("Codex already has several tasks queued. Please try that request again after one finishes.")
        .catch(() => this.emit({ type: "error", message: "The Codex queue-full notice could not be spoken." }));
      return;
    }
    this.queuedTasks.push(task);
    this.emit({
      type: "handoff.queued",
      taskId: task.id,
      transcript,
      position: this.queuedTasks.length,
    });
    void this.speak(
      `Codex is still working on your earlier task. I queued this request in position ${this.queuedTasks.length}.`,
    ).catch(() => this.emit({ type: "error", message: "The Codex queue acknowledgement could not be spoken." }));
    this.publishTaskState();
  }

  private acknowledgeHandoff(transcript: string): void {
    const configured = this.options.handoffAcknowledgement;
    const acknowledgement = typeof configured === "function"
      ? configured(transcript)
      : configured;
    if (!acknowledgement?.trim()) return;
    void this.speak(acknowledgement).catch(() => this.emit({
      type: "error",
      message: "Codex started, but its spoken acknowledgement failed.",
    }));
  }

  private async completeNativeRedirect(
    turnId: string,
    redirect: NativeHandoffRedirect,
  ): Promise<void> {
    if (!this.threadId) return;
    await this.expectResult("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    }, 5_000);
    await this.retryNativeHandoff(redirect.transcript, redirect.retry);
  }

  private async retryNativeHandoff(transcript: string, retry: boolean): Promise<void> {
    if (!this.threadId) return;
    if (!retry) {
      await this.speak(
        "Native web search isn’t available in this Live session, so I did not send that request to Codex.",
      );
      return;
    }
    await this.expectResult("thread/realtime/appendText", {
      threadId: this.threadId,
      role: "developer",
      text:
        "Routing correction: the immediately preceding request is native-only. Do not create a delegation. " +
        "Use GPT Live's first-party web search or current-information capability and answer it directly now.",
    }, 5_000);
    await this.expectResult("thread/realtime/appendText", {
      threadId: this.threadId,
      role: "user",
      text: `Native-only retry. Do not delegate to Codex: ${stripWakeWord(transcript)}`,
    }, 5_000);
  }

  private async handleTurnCompleted(params: JsonObject): Promise<void> {
    const task = this.activeTask;
    if (!task) return;
    const turn = asRecord(params["turn"]);
    const turnId = typeof turn?.["id"] === "string" ? turn["id"] : undefined;
    if (task.turnId && turnId && task.turnId !== turnId) return;
    if (turnId) task.turnId = turnId;
    const rawStatus = turn?.["status"];
    const status = rawStatus === "failed" || rawStatus === "interrupted" ? rawStatus : "completed";
    let fallbackSpeech = false;
    if (!task.spoke) {
      fallbackSpeech = true;
      const result = status === "completed" && !task.contaminated
        ? finalAgentSpeech(turn)
        : undefined;
      const speech = result ?? taskCompletionFallback(task.transcript, status);
      try {
        await this.speak(speech);
      } catch {
        this.emit({ type: "error", message: "Codex finished, but its completion notice could not be spoken." });
      }
    }
    this.emit({
      type: "handoff.completed",
      taskId: task.id,
      transcript: task.transcript,
      status,
      fallbackSpeech,
    });
    this.activeTask = undefined;
    this.publishTaskState();
    await this.startNextQueuedTask();
  }

  private async startNextQueuedTask(): Promise<void> {
    if (this.activeTask || !this.threadId) return;
    const task = this.queuedTasks.shift();
    if (!task) return;
    this.activeTask = task;
    try {
      const response = await this.expectResult("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: queuedDelegationPrompt(task) }],
      });
      const turn = asRecord(asRecord(response["result"])?.["turn"]);
      if (typeof turn?.["id"] === "string") task.turnId = turn["id"];
      this.emit({ type: "handoff.started", taskId: task.id, transcript: task.transcript, queued: true });
      void this.speak("I’ve started your next queued Codex task.").catch(() => this.emit({
        type: "error",
        message: "The queued-task start notice could not be spoken.",
      }));
      this.publishTaskState();
    } catch {
      this.activeTask = undefined;
      this.emit({
        type: "handoff.completed",
        taskId: task.id,
        transcript: task.transcript,
        status: "failed",
        fallbackSpeech: true,
      });
      await this.speak("I couldn’t start the next queued Codex task.").catch(() => {});
      await this.startNextQueuedTask();
    }
  }

  private publishTaskState(): void {
    if (!this.threadId) return;
    const text = this.activeTask
      ? `Runtime task state: Codex is BUSY with one delegated task; ${this.queuedTasks.length} additional task${this.queuedTasks.length === 1 ? " is" : "s are"} queued. While Codex is busy, use native GPT Live capabilities for ordinary answers and web searches. Do not hand the same request to Codex twice.`
      : "Runtime task state: Codex is IDLE and no delegated tasks are queued.";
    void this.expectResult("thread/realtime/appendText", {
      threadId: this.threadId,
      role: "developer",
      text,
    }, 5_000).catch(() => {});
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  private request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async expectResult(method: string, params: JsonObject, timeoutMs?: number): Promise<JsonObject> {
    const response = await this.request(method, params, timeoutMs);
    const error = asRecord(response["error"]);
    if (error) throw new Error(typeof error["message"] === "string" ? error["message"] : `${method} failed.`);
    return response;
  }

  private notify(method: string, params: JsonObject): void {
    this.send({ method, params });
  }

  private send(message: JsonObject): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not running.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private waitForNotification(method: string, timeoutMs: number): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const waiters = this.notificationWaiters.get(method)?.filter((entry) => entry !== waiter);
          if (waiters?.length) this.notificationWaiters.set(method, waiters);
          else this.notificationWaiters.delete(method);
          reject(new Error(`Timed out waiting for ${method}.`));
        }, timeoutMs),
      };
      this.notificationWaiters.set(method, [...(this.notificationWaiters.get(method) ?? []), waiter]);
    });
  }

  private handleProcessStop(error: Error): void {
    if (this.processStopped) return;
    this.processStopped = true;
    if (!this.closed) this.emit({ type: "error", message: "Codex app-server stopped unexpectedly." });
    this.rejectPending(error);
    void this.close().catch(() => {
      this.emit({ type: "error", message: "Realtime cleanup failed." });
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const waiters of this.notificationWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.notificationWaiters.clear();
  }

  private emit(event: RealtimeBridgeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // An application status listener must not interrupt protocol handling.
      }
    }
  }
}

function normalizeTranscript(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stripWakeWord(value: string): string {
  return value.replace(/^\s*juniper\s*[,;:.-]?\s*/i, "").trim();
}

function nativeRedirectKey(value: string): string {
  return normalizeTranscript(
    stripWakeWord(value).replace(
      /^native-only retry\.\s*do not delegate to codex:\s*/i,
      "",
    ),
  );
}

function handoffContext(item: JsonObject): string | undefined {
  const entries = Array.isArray(item["active_transcript"])
    ? item["active_transcript"]
    : Array.isArray(item["activeTranscript"])
      ? item["activeTranscript"]
      : [];
  for (let index = entries.length - 2; index >= 0; index -= 1) {
    const entry = asRecord(entries[index]);
    const role = entry?.["role"];
    const text = entry?.["text"];
    if (role !== "assistant" || typeof text !== "string") continue;
    const cleaned = text.trim();
    if (!cleaned || /started that task with codex|codex is still working|queued this request/i.test(cleaned)) {
      continue;
    }
    return cleaned.slice(0, 1_000);
  }
  return undefined;
}

function queuedDelegationPrompt(task: DelegatedTask): string {
  const context = task.context
    ? `\n  <immediate_context>${escapeXml(task.context)}</immediate_context>`
    : "";
  return (
    `<realtime_delegation queued="true">\n  <input>${escapeXml(task.transcript)}</input>${context}\n` +
    "</realtime_delegation>\n" +
    "This is one isolated queued request. Complete only this request; do not replay or merge earlier voice turns."
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function finalAgentSpeech(turn: JsonObject | undefined): string | undefined {
  const items = Array.isArray(turn?.["items"]) ? turn["items"] : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (item?.["type"] !== "agentMessage" || typeof item["text"] !== "string") continue;
    const cleaned = item["text"]
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[*_`#>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) return cleaned.slice(0, 500);
  }
  return undefined;
}

function taskCompletionFallback(
  transcript: string,
  status: "completed" | "failed" | "interrupted",
): string {
  if (status === "failed") return "That Codex task failed. Please ask me to retry it.";
  if (status === "interrupted") return "That Codex task was interrupted before it finished.";
  if (/\b(game|website|web page|html)\b/i.test(transcript)) {
    return "Codex finished your earlier build task.";
  }
  if (/\b(file|folder|project|code|app)\b/i.test(transcript)) {
    return "Codex finished your earlier workspace task.";
  }
  if (/\b(mac|volume|open|launch|computer)\b/i.test(transcript)) {
    return "Codex finished your earlier Mac task.";
  }
  return "Codex finished your earlier task.";
}

const INHERITED_APP_SERVER_ENV = [
  "PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
] as const;

function appServerEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: home,
    RUST_LOG: process.env["RUST_LOG"] ?? "warn",
  };
  for (const key of INHERITED_APP_SERVER_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function isProcessRunning(process: ChildProcessWithoutNullStreams): boolean {
  return process.exitCode === null && process.signalCode === null;
}

function waitForProcessExit(
  process: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (!isProcessRunning(process)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      process.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(!isProcessRunning(process)), timeoutMs);
    process.once("exit", onExit);
    if (!isProcessRunning(process)) finish(true);
  });
}

function speakToolSpec(): RealtimeDynamicTool {
  return {
    type: "function",
    name: SPEAK_TOOL,
    description: "Speak one concise result through the active native GPT Live session.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  };
}

function dynamicToolResponse(output: unknown, success = true): JsonObject {
  const text = assertJsonSerializable(output, "Dynamic tool output");
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function assertJsonSerializable(output: unknown, label: string): string {
  const text = JSON.stringify(output);
  if (text === undefined) throw new TypeError(`${label} must be JSON-serializable.`);
  return text;
}

export function chatgptPlanType(tokens: ChatGPTTokens): string | undefined {
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) continue;
    try {
      const encoded = token.split(".")[1];
      if (!encoded) continue;
      const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as JsonObject;
      const auth = asRecord(claims["https://api.openai.com/auth"]);
      const plan = auth?.["chatgpt_plan_type"];
      if (typeof plan === "string" && plan) return plan;
    } catch {
      // Try the other signed token.
    }
  }
  return undefined;
}

/** @internal Builds the entitlement-sensitive app-server execution selection. */
export function realtimeExecutionConfig(
  options: Pick<StartRealtimeAppServerOptions, "model" | "reasoningEffort">,
): JsonObject {
  return {
    ...(options.model ? { model: options.model } : {}),
    config: { model_reasoning_effort: options.reasoningEffort ?? "low" },
  };
}

/** @internal Builds authoritative native Live context without an agent handoff. */
export function realtimeClockContext(
  options: Pick<StartRealtimeAppServerOptions, "timezone" | "timezoneOffsetMinutes">,
  now = new Date(),
): string {
  if (Number.isNaN(now.getTime())) throw new TypeError("The server clock returned an invalid date.");
  const timezone = options.timezone
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? "UTC";
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const speakableTime = formatSpeakableTime(now, timezone);
  const offset = options.timezoneOffsetMinutes;
  return (
    `Authoritative owner clock snapshot captured live by the Mac bridge: ${local}. ` +
    `Speech-ready local time: ${speakableTime}. ` +
    `IANA timezone: ${timezone}. UTC instant: ${now.toISOString()}.` +
    (typeof offset === "number" ? ` JavaScript timezone offset minutes: ${offset}.` : "") +
    " Answer current date, day, time, and timezone questions directly and immediately from this live " +
    "clock context and the conversation's elapsed time. Never hand these questions to Codex, never use a " +
    "tool or web search for them, and never say that you are checking. Always pronounce the hour as a whole " +
    "number word: for example, 12:50 is 'twelve fifty', never 'one two fifty'."
  );
}

function formatSpeakableTime(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "long",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  const hourWords = [
    "twelve", "one", "two", "three", "four", "five", "six",
    "seven", "eight", "nine", "ten", "eleven", "twelve",
  ];
  const small = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen",
  ];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty"];
  const minuteWords = minute === 0
    ? "o'clock"
    : minute < 10
      ? `oh ${small[minute]}`
      : minute < 20
        ? small[minute]
        : `${tens[Math.floor(minute / 10)]}${minute % 10 ? ` ${small[minute % 10]}` : ""}`;
  const period = value("dayPeriod").toUpperCase().replace("AM", "A.M.").replace("PM", "P.M.");
  return `${hourWords[hour] ?? String(hour)} ${minuteWords} ${period} ${value("timeZoneName")}`.trim();
}

function unsupportedAttestationToken(): string {
  const encoder = new TextEncoder();
  const text = (value: string) => {
    const bytes = encoder.encode(value);
    if (bytes.length >= 24) throw new Error("Attestation field is unexpectedly long.");
    return Uint8Array.from([0x60 + bytes.length, ...bytes]);
  };
  const bytes = Uint8Array.from([
    0xa2,
    ...text("error_code"), 0x01,
    ...text("bundle_id"), ...text("com.openai.codex"),
  ]);
  return `v1.${Buffer.from(bytes).toString("base64url")}`;
}

function asRecord(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}
