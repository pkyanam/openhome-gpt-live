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
  | { type: "handoff.started"; taskId: string; transcript: string; activeCount: number }
  | { type: "handoff.deduplicated"; transcript: string }
  | { type: "handoff.redirected"; transcript: string; destination: "native" }
  | { type: "search.started"; taskId: string; transcript: string }
  | {
    type: "search.completed";
    taskId: string;
    transcript: string;
    status: "completed" | "failed";
  }
  | { type: "spotify.started"; taskId: string; transcript: string }
  | {
    type: "spotify.completed";
    taskId: string;
    transcript: string;
    status: "completed" | "failed";
  }
  | {
    type: "handoff.completed";
    taskId: string;
    transcript: string;
    status: "completed" | "failed" | "interrupted";
    fallbackSpeech: boolean;
    activeCount: number;
  }
  | { type: "tool.running"; callId: string; name: string }
  | { type: "tool.completed"; callId: string; name: string }
  | { type: "tool.pending_confirmation"; callId: string; name: string; review: unknown }
  | { type: "tool.failed"; callId?: string; name?: string; message: string }
  | { type: "error"; message: string };

export type ExternalVoiceCommandDisposition = "accepted" | "ignored" | "deduplicated";

export interface RealtimeSpotifyResult {
  speech: string;
  /** Music itself is the success signal for mutations; status queries still speak. */
  speakCompletion?: boolean;
}

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
  /** Runs a first-party OpenAI web search without starting a Codex turn. */
  executeSearch?: (transcript: string) => Promise<string>;
  /** Spoken immediately after the OpenAI search lane accepts a handoff. */
  searchAcknowledgement?: string | ((transcript: string) => string | undefined);
  /** Runs a routine media command through the separate OpenHome Spotify Ability. */
  executeSpotify?: (
    transcript: string,
    requestId: string,
  ) => Promise<string | RealtimeSpotifyResult>;
  /** Spoken before the Spotify Ability begins resolving or mutating playback. */
  spotifyAcknowledgement?: string | ((transcript: string) => string | undefined);
  /**
   * Routes an incoming native handoff. Returning `native` retries the request
   * in GPT Live; `openai_search` and `spotify` run their deterministic service
   * lanes independently. Codex requests start in isolated execution threads.
   */
  routeHandoff?: (transcript: string) => "codex" | "native" | "openai_search" | "spotify";
  /** Classifies an accepted Codex handoff for its execution contract and safety limits. */
  classifyHandoff?: (transcript: string) => "general" | "computer" | "media";
  cwd?: string;
  /** Defaults to read-only. Use workspace-write only for an explicitly scoped cwd. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Maximum lifetime of an ordinary delegated task. Defaults to five minutes. */
  taskTimeoutMs?: number;
  /** Maximum lifetime of a direct computer-control task. Defaults to two minutes. */
  computerTaskTimeoutMs?: number;
  /** Maximum lifetime of a media playback task. Defaults to ninety seconds. */
  mediaTaskTimeoutMs?: number;
  /** Injectable owner clock for deterministic integrations and tests. */
  now?: () => number;
}

export interface StartRealtimeAppServerOptions {
  sdp: string;
  voice?: string;
  /** Server-owned wake phrase removed before routing or delegated execution. */
  wakePhrase?: string;
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
  kind: "general" | "computer" | "media";
  createdAt: number;
  threadId?: string;
  turnId?: string;
  spoke: boolean;
  completing: boolean;
  actionCount: number;
  actionFingerprints: Set<string>;
  timeout?: ReturnType<typeof setTimeout>;
}

interface SearchHandoff {
  id: string;
  transcript: string;
  normalizedTranscript: string;
}

interface SpotifyHandoff {
  id: string;
  transcript: string;
  normalizedTranscript: string;
}

const SPEAK_TOOL = "speak_to_user";
const MAX_PARALLEL_HANDOFFS = 4;
const HANDOFF_DEDUPE_MS = 30_000;
const NATIVE_RETRY_GUARD_MS = 8_000;
const MEDIA_REPLAY_GUARD_MS = 5_000;
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_COMPUTER_TASK_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MEDIA_TASK_TIMEOUT_MS = 90_000;
const MAX_MEDIA_TASK_ACTIONS = 8;
const MAX_COMPUTER_TASK_ACTIONS = 20;
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
  private activeTasks = new Map<string, DelegatedTask>();
  private tasksByThreadId = new Map<string, DelegatedTask>();
  private completedTaskThreads = new Set<string>();
  private recentHandoffs = new Map<string, number>();
  private recentNativeRedirects = new Map<string, number>();
  private recentSearches = new Map<string, number>();
  private activeSearches = new Map<string, SearchHandoff>();
  private recentSpotifyRequests = new Map<string, number>();
  private activeSpotifyRequests = new Map<string, SpotifyHandoff>();
  private lastNativeRedirectAt?: number;
  private lastMediaHandoffAt?: number;
  private currentVoiceTurnId?: string;
  private claimedVoiceTurnId?: string;
  private activeRealtimeTurnId?: string;
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
          // The bridge routes every handoff itself. Codex requests get a new
          // execution thread, while native and search requests stay completely
          // independent of running Codex work.
          clientManagedHandoffs: true,
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

  /**
   * Opens a server-enforced routing transaction for one physical wake event.
   * The first backend handoff in the transaction owns it; later handoffs from
   * the same native Live turn are ignored even when they are rephrased or
   * target a different execution lane.
   */
  beginVoiceTurn(turnId: string): void {
    const normalized = turnId.trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(normalized)) {
      throw new TypeError("Voice turn id must contain 8-128 URL-safe characters.");
    }
    if (normalized === this.currentVoiceTurnId) return;
    this.currentVoiceTurnId = normalized;
    this.claimedVoiceTurnId = undefined;
  }

  /**
   * Claims a locally transcribed speaker-media command before `/wm` decides
   * whether to emit a handoff. Only the Spotify lane is accepted here;
   * conversation, search, and Codex routing remain native GPT Live behavior.
   */
  async submitExternalVoiceCommand(
    turnId: string,
    rawTranscript: string,
  ): Promise<ExternalVoiceCommandDisposition> {
    const transcript = stripWakeWord(rawTranscript.trim(), this.startOptions?.wakePhrase);
    if (!transcript || this.options.routeHandoff?.(transcript) !== "spotify") return "ignored";
    this.beginVoiceTurn(turnId);
    if (this.claimedVoiceTurnId === this.currentVoiceTurnId) return "deduplicated";
    if (this.threadId && this.activeRealtimeTurnId) {
      await this.interruptTurn(this.threadId, this.activeRealtimeTurnId);
      this.activeRealtimeTurnId = undefined;
    }
    this.handleHandoff({ type: "handoff_request", input_transcript: transcript });
    return this.claimedVoiceTurnId === this.currentVoiceTurnId ? "accepted" : "deduplicated";
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

  /**
   * Legacy compatibility endpoint.
   *
   * Appending a developer clock item during an open microphone turn can make
   * `/wm` answer the timestamp instead of the owner's actual request. Exact
   * time is already provided on demand by `currentTime/read`, so a refresh must
   * not mutate the realtime thread.
   */
  async refreshClock(): Promise<void> {
    if (!this.threadId || !this.startOptions) throw new Error("Realtime session is not running.");
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
      for (const task of this.activeTasks.values()) {
        if (task.timeout) clearTimeout(task.timeout);
      }
      this.activeTasks.clear();
      this.tasksByThreadId.clear();
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
    const requestThreadId = typeof params["threadId"] === "string" ? params["threadId"] : undefined;
    if (requestThreadId && this.completedTaskThreads.has(requestThreadId)) {
      this.send({ id, result: dynamicToolResponse({ status: "task_already_finished" }) });
      this.emit({ type: "tool.completed", callId, name });
      return;
    }
    if (name === SPEAK_TOOL) {
      const text = args["text"];
      if (typeof text !== "string" || !text.trim()) throw new Error("speak_to_user requires text.");
      const task = this.taskForRequest(params);
      if (task?.spoke || task?.completing) {
        this.send({ id, result: dynamicToolResponse({ status: "already_spoken" }) });
        this.emit({ type: "tool.completed", callId, name });
        return;
      }
      if (task) task.spoke = true;
      // Acknowledge the server-initiated tool call before sending another
      // client request to that same app-server process. Some app-server
      // versions serialize these messages; awaiting appendSpeech first makes
      // each side wait on the other forever and wedges the Live conversation.
      this.send({ id, result: dynamicToolResponse({ status: "spoken" }) });
      try {
        await this.speak(text);
      } catch {
        this.emit({ type: "error", message: "Codex completed, but its result could not be spoken." });
      }
      this.emit({ type: "tool.completed", callId, name });
      if (task) {
        const threadId = task.threadId;
        const turnId = task.turnId;
        this.finalizeTask(task, "completed", false);
        if (threadId && turnId) void this.interruptTurn(threadId, turnId);
      }
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
      const threadId = typeof params["threadId"] === "string" ? params["threadId"] : undefined;
      const turn = asRecord(params["turn"]);
      if (threadId === this.threadId && typeof turn?.["id"] === "string") {
        this.activeRealtimeTurnId = turn["id"];
      }
      const task = threadId ? this.tasksByThreadId.get(threadId) : undefined;
      if (task && !task.turnId && typeof turn?.["id"] === "string") {
        task.turnId = turn["id"];
      }
    } else if (method === "item/started") {
      this.handleItemStarted(params);
    } else if (method === "item/completed") {
      this.handleItemCompleted(params);
    } else if (method === "turn/completed") {
      const threadId = typeof params["threadId"] === "string" ? params["threadId"] : undefined;
      const turn = asRecord(params["turn"]);
      if (
        threadId === this.threadId
        && typeof turn?.["id"] === "string"
        && turn["id"] === this.activeRealtimeTurnId
      ) {
        this.activeRealtimeTurnId = undefined;
      }
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
    const rawTranscript = (typeof item["input_transcript"] === "string"
      ? item["input_transcript"]
      : typeof item["input"] === "string"
        ? item["input"]
        : "").trim();
    const transcript = stripWakeWord(rawTranscript, this.startOptions?.wakePhrase);
    if (!transcript) return;
    if (
      this.currentVoiceTurnId
      && this.claimedVoiceTurnId === this.currentVoiceTurnId
    ) {
      this.emit({ type: "handoff.deduplicated", transcript });
      return;
    }
    if (this.currentVoiceTurnId) this.claimedVoiceTurnId = this.currentVoiceTurnId;
    const normalizedTranscript = normalizeTranscript(transcript);
    const now = this.nowMs();
    for (const [key, seenAt] of this.recentHandoffs) {
      if (now - seenAt >= HANDOFF_DEDUPE_MS) this.recentHandoffs.delete(key);
    }
    for (const [key, seenAt] of this.recentNativeRedirects) {
      if (now - seenAt >= HANDOFF_DEDUPE_MS) this.recentNativeRedirects.delete(key);
    }
    for (const [key, seenAt] of this.recentSearches) {
      if (now - seenAt >= HANDOFF_DEDUPE_MS) this.recentSearches.delete(key);
    }
    for (const [key, seenAt] of this.recentSpotifyRequests) {
      if (now - seenAt >= HANDOFF_DEDUPE_MS) this.recentSpotifyRequests.delete(key);
    }
    const destination = this.options.routeHandoff?.(transcript) ?? "codex";
    if (destination === "native") {
      const redirectKey = nativeRedirectKey(transcript);
      if (
        this.recentNativeRedirects.has(redirectKey)
        || (
          this.lastNativeRedirectAt !== undefined
          && now - this.lastNativeRedirectAt < NATIVE_RETRY_GUARD_MS
        )
      ) {
        this.emit({ type: "handoff.deduplicated", transcript });
        return;
      }
      this.recentNativeRedirects.set(redirectKey, now);
      this.lastNativeRedirectAt = now;
      this.emit({ type: "handoff.redirected", transcript, destination: "native" });
      void this.retryNativeHandoff(transcript).catch(() => this.emit({
        type: "error",
        message: "The native GPT Live retry failed.",
      }));
      return;
    }
    if (destination === "openai_search") {
      if (!this.options.executeSearch) {
        void this.speak("OpenAI web search is not configured for this speaker.").catch(() => {});
        this.emit({ type: "error", message: "OpenAI web search is not configured." });
        return;
      }
      if (
        this.activeSearches.has(normalizedTranscript)
        || this.recentSearches.has(normalizedTranscript)
      ) {
        this.emit({ type: "handoff.deduplicated", transcript });
        return;
      }
      this.recentSearches.set(normalizedTranscript, now);
      const search: SearchHandoff = {
        id: crypto.randomUUID(),
        transcript,
        normalizedTranscript,
      };
      this.activeSearches.set(normalizedTranscript, search);
      this.emit({ type: "search.started", taskId: search.id, transcript });
      this.acknowledgeSearch(transcript);
      void this.runSearch(search);
      return;
    }
    if (destination === "spotify") {
      if (!this.options.executeSpotify) {
        void this.speak("Spotify is not configured for this speaker.").catch(() => {});
        this.emit({ type: "error", message: "The Spotify Ability is not configured." });
        return;
      }
      if (
        this.activeSpotifyRequests.has(normalizedTranscript)
        || this.recentSpotifyRequests.has(normalizedTranscript)
      ) {
        this.emit({ type: "handoff.deduplicated", transcript });
        return;
      }
      this.recentSpotifyRequests.set(normalizedTranscript, now);
      const spotify: SpotifyHandoff = {
        id: crypto.randomUUID(),
        transcript,
        normalizedTranscript,
      };
      this.activeSpotifyRequests.set(normalizedTranscript, spotify);
      this.emit({ type: "spotify.started", taskId: spotify.id, transcript });
      void this.runSpotify(spotify);
      return;
    }
    const kind = this.options.classifyHandoff?.(transcript) ?? delegatedTaskKind(transcript);
    if (
      [...this.activeTasks.values()].some((task) => task.normalizedTranscript === normalizedTranscript)
      || this.recentHandoffs.has(normalizedTranscript)
    ) {
      this.emit({ type: "handoff.deduplicated", transcript });
      return;
    }
    if (
      kind === "media"
      && (
        [...this.activeTasks.values()].some((task) => task.kind === "media")
        || (
          this.lastMediaHandoffAt !== undefined
          && now - this.lastMediaHandoffAt < MEDIA_REPLAY_GUARD_MS
        )
      )
    ) {
      this.emit({ type: "handoff.deduplicated", transcript });
      return;
    }
    if (this.activeTasks.size >= MAX_PARALLEL_HANDOFFS) {
      void this.speak(
        `Codex is already running ${MAX_PARALLEL_HANDOFFS} tasks. Please try that request again after one finishes.`,
      ).catch(() => this.emit({ type: "error", message: "The Codex capacity notice could not be spoken." }));
      return;
    }
    this.recentHandoffs.set(normalizedTranscript, now);
    if (kind === "media") this.lastMediaHandoffAt = now;
    const task: DelegatedTask = {
      id: crypto.randomUUID(),
      transcript,
      normalizedTranscript,
      kind,
      createdAt: now,
      spoke: false,
      completing: false,
      actionCount: 0,
      actionFingerprints: new Set(),
    };
    this.emit({ type: "handoff", transcript });
    this.activeTasks.set(task.id, task);
    task.timeout = setTimeout(
      () => void this.timeoutTask(task),
      this.timeoutForTask(task),
    );
    // Acceptance belongs to the responsive Live conversation, not to Codex
    // startup. A new task thread can take longer than the speaker's silence
    // watchdog, so acknowledge and expose the task before awaiting it.
    this.emit({
      type: "handoff.started",
      taskId: task.id,
      transcript: task.transcript,
      activeCount: this.activeTasks.size,
    });
    this.acknowledgeHandoff(task.transcript);
    this.publishTaskState();
    void this.startDelegatedTask(task);
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

  private acknowledgeSearch(transcript: string): void {
    const configured = this.options.searchAcknowledgement;
    const acknowledgement = typeof configured === "function"
      ? configured(transcript)
      : configured ?? "I’m searching OpenAI now. You can keep talking while I check.";
    if (!acknowledgement?.trim()) return;
    void this.speak(acknowledgement).catch(() => this.emit({
      type: "error",
      message: "OpenAI search started, but its spoken acknowledgement failed.",
    }));
  }

  private async runSearch(search: SearchHandoff): Promise<void> {
    let status: "completed" | "failed" = "completed";
    try {
      const result = await this.options.executeSearch!(search.transcript);
      if (!result.trim()) throw new Error("OpenAI web search returned no result.");
      await this.speak(result);
    } catch {
      status = "failed";
      await this.speak("I couldn’t complete that OpenAI web search. Please try again.").catch(() => {});
    } finally {
      this.activeSearches.delete(search.normalizedTranscript);
      this.emit({
        type: "search.completed",
        taskId: search.id,
        transcript: search.transcript,
        status,
      });
    }
  }

  private async runSpotify(spotify: SpotifyHandoff): Promise<void> {
    let status: "completed" | "failed" = "completed";
    try {
      const configured = this.options.spotifyAcknowledgement;
      const acknowledgement = typeof configured === "function"
        ? configured(spotify.transcript)
        : configured ?? "Starting that on Spotify now.";
      if (acknowledgement?.trim()) await this.speak(acknowledgement);
      const result = await this.options.executeSpotify!(spotify.transcript, spotify.id);
      const speech = typeof result === "string" ? result : result.speech;
      if (!speech.trim()) throw new Error("The Spotify Ability returned no result.");
      if (typeof result === "string" || result.speakCompletion !== false) {
        await this.speak(speech);
      }
    } catch {
      status = "failed";
      await this.speak("I couldn’t complete that Spotify request. Please try again.").catch(() => {});
    } finally {
      this.activeSpotifyRequests.delete(spotify.normalizedTranscript);
      this.emit({
        type: "spotify.completed",
        taskId: spotify.id,
        transcript: spotify.transcript,
        status,
      });
    }
  }

  private async retryNativeHandoff(transcript: string): Promise<void> {
    if (!this.threadId) return;
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
      text: `Native-only retry. Do not delegate to Codex: ${transcript}`,
    }, 5_000);
  }

  private async handleTurnCompleted(params: JsonObject): Promise<void> {
    const task = this.taskForRequest(params);
    if (!task || task.completing) return;
    const turn = asRecord(params["turn"]);
    const turnId = typeof turn?.["id"] === "string" ? turn["id"] : undefined;
    if (task.turnId && turnId && task.turnId !== turnId) return;
    if (turnId) task.turnId = turnId;
    task.completing = true;
    if (task.timeout) clearTimeout(task.timeout);
    const rawStatus = turn?.["status"];
    const status = rawStatus === "failed" || rawStatus === "interrupted" ? rawStatus : "completed";
    let fallbackSpeech = false;
    if (!task.spoke) {
      fallbackSpeech = true;
      const result = status === "completed" ? finalAgentSpeech(turn) : undefined;
      const speech = result ?? taskCompletionFallback(task.transcript, status);
      try {
        await this.speak(speech);
      } catch {
        this.emit({ type: "error", message: "Codex finished, but its completion notice could not be spoken." });
      }
    }
    this.finalizeTask(task, status, fallbackSpeech);
  }

  private async startDelegatedTask(task: DelegatedTask): Promise<void> {
    const startOptions = this.startOptions;
    const home = this.home;
    try {
      if (!startOptions || !home) throw new Error("Realtime execution is not initialized.");
      if (!this.activeTasks.has(task.id)) return;
      const threadResponse = await this.expectResult("thread/start", {
        cwd: this.options.cwd ?? home,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: this.options.sandbox ?? "read-only",
        threadSource: "realtime_voice",
        baseInstructions: this.options.executionInstructions ?? DEFAULT_EXECUTION_INSTRUCTIONS,
        developerInstructions: this.options.executionInstructions ?? DEFAULT_EXECUTION_INSTRUCTIONS,
        dynamicTools: [...this.options.tools, speakToolSpec()],
        ...realtimeExecutionConfig(startOptions),
      });
      const thread = asRecord(asRecord(threadResponse["result"])?.["thread"]);
      if (typeof thread?.["id"] !== "string") throw new Error("App-server returned no task thread id.");
      if (!this.activeTasks.has(task.id)) return;
      task.threadId = thread["id"];
      this.tasksByThreadId.set(task.threadId, task);

      const turnResponse = await this.expectResult("turn/start", {
        threadId: task.threadId,
        input: [{ type: "text", text: delegationPrompt(task) }],
      });
      const turn = asRecord(asRecord(turnResponse["result"])?.["turn"]);
      if (typeof turn?.["id"] === "string") task.turnId = turn["id"];
      if (!this.activeTasks.has(task.id)) {
        if (task.threadId && task.turnId) void this.interruptTurn(task.threadId, task.turnId);
        return;
      }
    } catch {
      if (!this.activeTasks.has(task.id)) return;
      this.recentHandoffs.delete(task.normalizedTranscript);
      this.finalizeTask(task, "failed", true);
      await this.speak("I couldn’t start that Codex task. Please try again.").catch(() => {});
    }
  }

  private async timeoutTask(task: DelegatedTask): Promise<void> {
    const label = task.kind === "media"
      ? "That media task was taking too long, so I stopped it before it could keep clicking or open duplicates."
      : "That Codex task was taking too long, so I stopped it. Please try a narrower request.";
    await this.stopTask(task, label);
  }

  private handleItemStarted(params: JsonObject): void {
    const task = this.taskForRequest(params);
    const item = asRecord(params["item"]);
    if (!task || task.completing || !isActionItem(item)) return;
    const fingerprint = actionFingerprint(item);
    if (fingerprint && task.actionFingerprints.has(fingerprint)) {
      void this.stopTask(
        task,
        "I stopped that task before it could repeat the same computer action.",
      );
      return;
    }
    if (fingerprint) task.actionFingerprints.add(fingerprint);
    task.actionCount += 1;
    const limit = task.kind === "media"
      ? MAX_MEDIA_TASK_ACTIONS
      : task.kind === "computer"
        ? MAX_COMPUTER_TASK_ACTIONS
        : undefined;
    if (limit !== undefined && task.actionCount > limit) {
      void this.stopTask(
        task,
        "I stopped that computer task because it exceeded its safe interaction limit without finishing.",
      );
    }
  }

  private handleItemCompleted(params: JsonObject): void {
    const task = this.taskForRequest(params);
    const item = asRecord(params["item"]);
    if (
      !task
      || task.completing
      || task.kind !== "media"
      || !isPlaybackStartRequest(task.transcript)
      || !itemShowsActivePlayback(item)
    ) return;
    void this.completeTaskFromGuard(task, "Playback started.");
  }

  private async completeTaskFromGuard(task: DelegatedTask, speech: string): Promise<void> {
    if (!this.activeTasks.has(task.id) || task.completing) return;
    task.spoke = true;
    task.completing = true;
    const threadId = task.threadId;
    const turnId = task.turnId;
    this.finalizeTask(task, "completed", false);
    if (threadId && turnId) void this.interruptTurn(threadId, turnId);
    await this.speak(speech).catch(() => {});
  }

  private async stopTask(task: DelegatedTask, speech: string): Promise<void> {
    if (!this.activeTasks.has(task.id) || task.completing) return;
    task.spoke = true;
    task.completing = true;
    const threadId = task.threadId;
    const turnId = task.turnId;
    this.finalizeTask(task, "interrupted", true);
    if (threadId && turnId) void this.interruptTurn(threadId, turnId);
    await this.speak(speech).catch(() => {});
  }

  private finalizeTask(
    task: DelegatedTask,
    status: "completed" | "failed" | "interrupted",
    fallbackSpeech: boolean,
  ): void {
    if (!this.activeTasks.has(task.id)) return;
    if (task.timeout) clearTimeout(task.timeout);
    this.activeTasks.delete(task.id);
    if (task.threadId) {
      this.tasksByThreadId.delete(task.threadId);
      this.completedTaskThreads.add(task.threadId);
    }
    this.emit({
      type: "handoff.completed",
      taskId: task.id,
      transcript: task.transcript,
      status,
      fallbackSpeech,
      activeCount: this.activeTasks.size,
    });
    this.publishTaskState();
  }

  private timeoutForTask(task: DelegatedTask): number {
    if (task.kind === "media") {
      return this.options.mediaTaskTimeoutMs ?? DEFAULT_MEDIA_TASK_TIMEOUT_MS;
    }
    if (task.kind === "computer") {
      return this.options.computerTaskTimeoutMs ?? DEFAULT_COMPUTER_TASK_TIMEOUT_MS;
    }
    return this.options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.expectResult("turn/interrupt", { threadId, turnId }, 5_000).catch(() => {});
  }

  private publishTaskState(): void {
    if (!this.threadId) return;
    const count = this.activeTasks.size;
    const text = count > 0
      ? `Runtime task state: Codex has ${count} independent task${count === 1 ? "" : "s"} running in parallel. Native GPT Live remains available for ordinary answers and web searches. Each new action may start in its own Codex thread. Do not hand the same request to Codex twice.`
      : "Runtime task state: Codex is IDLE and no delegated tasks are running.";
    void this.expectResult("thread/realtime/appendText", {
      threadId: this.threadId,
      role: "developer",
      text,
    }, 5_000).catch(() => {});
  }

  private taskForRequest(params: JsonObject): DelegatedTask | undefined {
    const threadId = params["threadId"];
    if (typeof threadId === "string") return this.tasksByThreadId.get(threadId);
    const turnId = params["turnId"];
    if (typeof turnId === "string") {
      return [...this.activeTasks.values()].find((task) => task.turnId === turnId);
    }
    const turn = asRecord(params["turn"]);
    const completedTurnId = turn?.["id"];
    if (typeof completedTurnId === "string") {
      return [...this.activeTasks.values()].find((task) => task.turnId === completedTurnId);
    }
    return undefined;
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

function delegatedTaskKind(value: string): DelegatedTask["kind"] {
  const normalized = normalizeTranscript(value);
  const mediaAction = /\b(play|stream|listen|watch|put on|pause|resume|stop|skip|next|previous|queue|shuffle|repeat|control|open|launch|close|quit|mute|unmute|turn up|turn down)\b/.test(normalized);
  const mediaTarget = /\b(song|track|music|album|playlist|podcast|audiobook|video|trailer|movie|show|youtube|spotify|apple music|music app|soundcloud)\b/.test(normalized);
  const bareMediaPlay = /^(?:please )?play\b/.test(normalized)
    && !/\b(chess|poker|checkers|game|games|sport|sports|football|basketball|baseball|tennis|devil s advocate|a role)\b/.test(normalized);
  if ((mediaAction && mediaTarget) || bareMediaPlay) return "media";
  if (/\b(browser|tab|window|helium|chrome|safari|open|launch|quit|control|click|select|scroll)\b/.test(normalized)) {
    return "computer";
  }
  return "general";
}

function isActionItem(item: JsonObject | undefined): boolean {
  return item?.["type"] === "commandExecution"
    || item?.["type"] === "fileChange"
    || item?.["type"] === "mcpToolCall"
    || item?.["type"] === "dynamicToolCall"
    || item?.["type"] === "webSearch"
    || item?.["type"] === "collabAgentToolCall";
}

function actionFingerprint(item: JsonObject | undefined): string | undefined {
  if (!item || !isActionItem(item)) return undefined;
  const type = typeof item["type"] === "string" ? item["type"] : "";
  const server = typeof item["server"] === "string" ? item["server"] : "";
  const tool = typeof item["tool"] === "string" ? item["tool"] : "";
  const command = typeof item["command"] === "string" ? item["command"] : "";
  const args = "arguments" in item ? stableJson(item["arguments"]) : "";
  return `${type}\u0000${server}\u0000${tool}\u0000${command}\u0000${args}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isPlaybackStartRequest(value: string): boolean {
  return /\b(play|stream|watch|listen|put on|resume)\b/i.test(value)
    && !/\b(pause|stop|close|quit)\b/i.test(value);
}

function itemShowsActivePlayback(item: JsonObject | undefined): boolean {
  if (!item) return false;
  const result = item["type"] === "mcpToolCall"
    ? item["result"]
    : item["type"] === "commandExecution"
      ? item["aggregatedOutput"]
      : undefined;
  const text = typeof result === "string" ? result : stableJson(result);
  if (!text || text === "undefined") return false;
  return /\bnow playing\b/i.test(text)
    || /\bplayer state\b.{0,40}\bplaying\b/is.test(text)
    || /\bplayback\b.{0,40}\b(?:started|playing|active)\b/is.test(text)
    || /\bbutton\b.{0,80}\bpause(?:\s*\([^)]*\))?\b/is.test(text);
}

function stripWakeWord(value: string, wakePhrase = "juniper"): string {
  const phrase = wakePhrase.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  if (!phrase) return value.trim();
  return value.replace(new RegExp(`^\\s*${phrase}\\b\\s*[,;:.-]?\\s*`, "i"), "").trim();
}

function nativeRedirectKey(value: string): string {
  return normalizeTranscript(
    value.replace(
      /^native-only retry\.\s*do not delegate to codex:\s*/i,
      "",
    ),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delegationPrompt(task: DelegatedTask): string {
  const taskContract = task.kind === "media"
    ? "\nMedia playback contract:\n" +
      "- Reuse an existing relevant browser tab or window whenever possible. Open at most one new tab and one media stream.\n" +
      "- Inspect the current page before clicking. If the requested media is already open or playing, focus it and finish.\n" +
      "- Choose one best matching result. Never open multiple candidates, duplicate a tab, or start a second playback stream.\n" +
      "- Once the requested media begins playing, stop browsing immediately, call speak_to_user, and take no further actions.\n" +
      "- Do not wait for the media to finish. If playback cannot be confirmed quickly, stop and report that instead of exploring."
    : task.kind === "computer"
      ? "\nComputer-control contract:\n" +
        "- Use the shortest deterministic path and reuse existing windows or tabs.\n" +
        "- Do not explore unrelated UI, repeat a successful action, or keep clicking after the requested state is visible.\n" +
        "- Verify the final state once, call speak_to_user, and stop immediately."
      : "\nChoose tools yourself. Use computer control only when the current request requires it. Finish the scoped task, call speak_to_user, and stop.";
  return (
    `<realtime_delegation parallel="true" kind="${task.kind}">\n  <input>${escapeXml(task.transcript)}</input>\n` +
    "</realtime_delegation>\n" +
    "The input above is the exact current user request. Do not infer a follow-up from earlier conversation. " +
    "This request has its own isolated Codex thread. Complete only this request. Other voice tasks may run " +
    "in parallel, so do not replay, merge, wait for, or report on them." +
    taskContract
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

/** @internal Builds authoritative native Live clock policy without a stale timestamp. */
export function realtimeClockContext(
  options: Pick<StartRealtimeAppServerOptions, "timezone" | "timezoneOffsetMinutes">,
  now = new Date(),
): string {
  if (Number.isNaN(now.getTime())) throw new TypeError("The server clock returned an invalid date.");
  const timezone = options.timezone
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? "UTC";
  const offset = options.timezoneOffsetMinutes;
  return (
    `Authoritative owner IANA timezone: ${timezone}.` +
    (typeof offset === "number" ? ` JavaScript timezone offset minutes: ${offset}.` : "") +
    " For an exact current date, day, or time, use this realtime thread's live currentTime/read provider. " +
    "Never answer from a session-start timestamp or elapsed-time estimate. Never hand these questions to " +
    "Codex or web search, and never say that you are checking. Always pronounce the hour as a whole " +
    "number word: for example, 12:50 is 'twelve fifty', never 'one two fifty'."
  );
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
