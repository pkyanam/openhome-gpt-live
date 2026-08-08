import { join, resolve } from "node:path";
import {
  createChatGPTHandler,
  type ChatGPTHandler,
  type StoredSession,
} from "@opencoredev/loginwithchatgpt-server";
import app from "../index.html";
import { DeviceRegistry, type DeviceRecord } from "./device-registry.ts";
import { createDeviceRoutes } from "./device-routes.ts";
import { JsonFileStore } from "./file-store.ts";
import { OpenHomeClient } from "./openhome-client.ts";
import { createOpenHomeToolPolicy } from "./openhome-tools.ts";
import { createCodexControlPolicy } from "./codex-control.ts";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = parsePort(process.env.PORT);
const lwcSecret = process.env.LWC_SECRET?.trim();
const bootstrapToken = process.env.DEVKIT_BOOTSTRAP_TOKEN?.trim();
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim() || undefined;
const allowedModels = splitCsv(process.env.LWC_ALLOWED_MODELS);
const configuredAllowedOrigins = splitCsv(process.env.LWC_ALLOWED_ORIGINS);
const allowedOrigins = configuredAllowedOrigins.length > 0
  ? configuredAllowedOrigins
  : publicBaseUrl ? [publicBaseUrl] : [];
const allowedChatGPTEmail = process.env.APP_ALLOWED_CHATGPT_EMAIL?.trim().toLowerCase();
const personalityPrompt = readOptionalPrompt(process.env.GPT_LIVE_PERSONALITY_PROMPT);
const dataDirectory = resolve(process.env.OPENHOME_GPT_DATA_DIR?.trim() || "data");
const codexWorkspace = resolve(process.env.CODEX_WORKSPACE?.trim() || process.cwd());
const codexMacControlMode = process.env.CODEX_MAC_CONTROL?.trim().toLowerCase() || "disabled";
const confirmedMacControl = codexMacControlMode === "confirmed";
const fullCodexAccess = codexMacControlMode === "full";
const loginSessionStore = new JsonFileStore<StoredSession>(join(dataDirectory, "login-sessions.json"));
const deviceStore = new JsonFileStore<DeviceRecord>(join(dataDirectory, "device-sessions.json"));
const openHome = new OpenHomeClient({
  apiKey: process.env.OPENHOME_API_KEY,
  baseUrl: process.env.OPENHOME_API_BASE,
});
const toolPolicy = createOpenHomeToolPolicy(openHome);
const codexControl = createCodexControlPolicy({
  enabled: confirmedMacControl,
  workspace: codexWorkspace,
});

if (!lwcSecret || lwcSecret.length < 32) {
  throw new Error("LWC_SECRET must contain at least 32 characters.");
}
if (!bootstrapToken || bootstrapToken.length < 32) {
  throw new Error("DEVKIT_BOOTSTRAP_TOKEN must contain at least 32 characters.");
}
if (process.env.NODE_ENV === "production" && !publicBaseUrl) {
  throw new Error("PUBLIC_BASE_URL is required in production.");
}
if (publicBaseUrl) validatePublicBaseUrl(publicBaseUrl);
if (!["disabled", "confirmed", "full"].includes(codexMacControlMode)) {
  throw new Error("CODEX_MAC_CONTROL must be disabled, confirmed, or full.");
}
if (isPubliclyReachable(host, publicBaseUrl) && !allowedChatGPTEmail) {
  throw new Error("APP_ALLOWED_CHATGPT_EMAIL is required for a non-loopback deployment.");
}

const deviceRegistry = new DeviceRegistry(deviceStore, lwcSecret);

let auth: ChatGPTHandler;
auth = createChatGPTHandler({
  secret: lwcSecret,
  sessionStore: loginSessionStore,
  allowedOrigins,
  enableResponsesProxy: true,
  enableRealtime: true,
  realtime: {
    appServer: {
      tools: [...toolPolicy.tools, ...codexControl.tools],
      executeTool: async (context) => {
        await requireAuthorizedToolUser(context.request);
        return context.name.startsWith("openhome_")
          ? toolPolicy.executeTool(context)
          : codexControl.executeTool(context);
      },
      confirmTool: async (context) => {
        await requireAuthorizedToolUser(context.request);
        return context.name.startsWith("openhome_")
          ? toolPolicy.confirmTool(context)
          : codexControl.confirmTool(context);
      },
      cwd: codexWorkspace,
      sandbox: fullCodexAccess ? "danger-full-access" : "workspace-write",
      ...(allowedModels.length > 0 ? { allowedModels } : {}),
      ...(process.env.LWC_DEFAULT_MODEL?.trim()
        ? { defaultModel: process.env.LWC_DEFAULT_MODEL.trim() }
        : {}),
      reasoningEffort: "low",
      handoffAcknowledgement:
        "Got it. I've started that task with Codex. I'll speak again when it finishes, and you can keep talking to me while it works.",
      executionInstructions:
        "You are the execution side of an OpenHome realtime voice assistant. " +
        "Only handle delegations that require the provided OpenHome dynamic tools or the configured workspace. " +
        "Never perform internet or web searches; native GPT Live owns its first-party web search, memory, " +
        "general knowledge, and ordinary conversation. Process only the current delegated request and do not " +
        "replay, reorder, or answer earlier conversation turns. Complete delegated tasks directly rather than " +
        "merely describing how the user could do them. " +
        (fullCodexAccess
          ? "You have owner-authorized full Mac access with no application approval step. You may inspect, create, " +
            "edit, execute, control macOS applications, and work outside the configured workspace when the current " +
            "request requires it. Do not broaden the current request. "
          : "You may inspect, create, edit, and test files inside the configured workspace using Codex " +
            "workspace-write tools. For macOS control or access outside that workspace, use " +
            "codex_prepare_mac_task and wait for paired-phone approval. ") +
        "Never claim a mutation completed when it is pending UI confirmation. " +
        "After finishing, call speak_to_user exactly once with a concise spoken result.",
      realtimePrompt:
        "You are an OpenHome voice assistant. Keep responses concise, natural, and interruptible. " +
        "Use GPT Live's native first-party capabilities directly for ordinary conversation, general knowledge, " +
        "memory, current information, and all internet or web searches. Answer current date, day, time, and timezone " +
        "questions directly from the authoritative owner clock in your developer startup context. Never hand off " +
        "a clock question, never say you are checking it, and never use web search for it. " +
        "When speaking a time, pronounce the hour as a whole number word: 12:50 is 'twelve fifty', never " +
        "'one two fifty'. " +
        "requests that require OpenHome account data, an OpenHome action, creating or changing files in the " +
        "configured local workspace, or controlling the paired Mac through Codex. " +
        (fullCodexAccess
          ? "Mac control is owner-authorized for direct delegated execution without phone confirmation. "
          : "Outside-workspace Mac control must use the confirmed Codex Mac tool. ") +
        "The bridge acknowledges a Codex handoff after execution actually starts. Do not add vague filler such " +
        "as 'checking' or 'one moment'. Do not independently perform or answer the same delegated task, but remain " +
        "available for new conversation and follow-up messages while Codex works in the background. When its spoken " +
        "result arrives, present it as the completion of the earlier task without replaying old turns." +
        (personalityPrompt ? `\n\nOpenHome personality instructions:\n${personalityPrompt}` : ""),
    },
  },
});

const deviceRoutes = createDeviceRoutes({
  auth,
  registry: deviceRegistry,
  bootstrapToken,
  publicBaseUrl,
});

const server = Bun.serve({
  hostname: host,
  port,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": app,
    "/setup": app,
    "/healthz": () => Response.json(
      { status: "ok", service: "openhome-gpt-live", version: "0.1.0" },
      { headers: { "cache-control": "no-store" } },
    ),
    "/api/chatgpt/*": (request) => auth.handler(request),
    "/api/device/*": deviceRoutes,
    "/api/pairing/*": deviceRoutes,
  },
});

console.log(`OpenHome GPT Live listening on ${server.url}`);
console.log(`Codex workspace: ${codexWorkspace}`);
console.log(`Codex access mode: ${fullCodexAccess ? "full" : confirmedMacControl ? "confirmed" : "workspace"}`);
console.log(`Persistent state directory: ${dataDirectory}`);
if (!process.env.OPENHOME_API_KEY) {
  console.warn("OPENHOME_API_KEY is not set; voice works, but OpenHome tools will return a configuration error.");
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function parsePort(value: string | undefined): number {
  const port = value ? Number(value) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isPubliclyReachable(bindHost: string, configuredPublicBaseUrl?: string): boolean {
  if (!isLoopbackHost(bindHost)) return true;
  if (!configuredPublicBaseUrl) return false;
  return !isLoopbackHost(new URL(configuredPublicBaseUrl).hostname);
}

function validatePublicBaseUrl(value: string): void {
  const url = new URL(value);
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new TypeError("PUBLIC_BASE_URL must use HTTPS unless it is loopback.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("PUBLIC_BASE_URL must contain only an origin, without credentials, a path, query, or fragment.");
  }
}

function readOptionalPrompt(value: string | undefined): string | undefined {
  const prompt = value?.trim();
  if (!prompt) return undefined;
  if (prompt.length > 20_000) {
    throw new TypeError("GPT_LIVE_PERSONALITY_PROMPT must contain at most 20,000 characters.");
  }
  return prompt;
}

async function requireAuthorizedToolUser(request: Request): Promise<void> {
  if (!allowedChatGPTEmail) return;
  const session = await auth.getSession(request);
  const actual = session.user?.email?.trim().toLowerCase();
  if (session.status !== "authenticated" || actual !== allowedChatGPTEmail) {
    throw new Error("This ChatGPT account is not authorized to use the configured OpenHome tools.");
  }
}
