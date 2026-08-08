import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type {
  RealtimeAppServerConfirmationContext,
  RealtimeAppServerToolContext,
  RealtimeConfirmationResult,
  RealtimeDynamicTool,
  RealtimeToolResult,
} from "@opencoredev/loginwithchatgpt-server";

const MAC_TASK_OPERATION = "codex.mac_task.v1";
const MAC_TASK_TOOL = "codex_prepare_mac_task";
const MAX_TASK_LENGTH = 4_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

export interface CodexControlPolicy {
  tools: readonly RealtimeDynamicTool[];
  executeTool(context: RealtimeAppServerToolContext): Promise<RealtimeToolResult>;
  confirmTool(context: RealtimeAppServerConfirmationContext): Promise<RealtimeConfirmationResult>;
}

export interface CodexControlOptions {
  enabled: boolean;
  workspace: string;
  runTask?: (task: string, workspace: string) => Promise<{ summary: string }>;
}

export function createCodexControlPolicy(options: CodexControlOptions): CodexControlPolicy {
  const runTask = options.runTask ?? runConfirmedCodexTask;
  return {
    tools: options.enabled ? MAC_CONTROL_TOOLS : [],
    async executeTool({ name, arguments: args }) {
      if (!options.enabled || name !== MAC_TASK_TOOL) {
        throw new Error(`Unknown or disabled Codex control tool: ${name}`);
      }
      const task = parseTask(args);
      return {
        output: {
          status: "pending_confirmation",
          operation: MAC_TASK_OPERATION,
          task,
          workspace: options.workspace,
        },
        pendingConfirmation: {
          review: {
            title: "Run Codex with Mac access",
            task,
            workspace: options.workspace,
            access: "May control macOS and read or write outside the configured workspace for this task only.",
          },
        },
      };
    },
    async confirmTool({ confirmation, pending }) {
      const approved = parseApproved(confirmation);
      const task = parsePendingTask(pending.output, options.workspace);
      if (!approved) {
        return {
          output: { status: "cancelled", operation: MAC_TASK_OPERATION },
          speech: "Okay, I did not run that Mac task.",
        };
      }
      const result = await runTask(task, options.workspace);
      return {
        output: {
          status: "completed",
          operation: MAC_TASK_OPERATION,
          summary: result.summary,
        },
        speech: conciseSpeech(result.summary),
      };
    },
  };
}

const MAC_CONTROL_TOOLS: readonly RealtimeDynamicTool[] = [
  {
    type: "function",
    name: MAC_TASK_TOOL,
    description:
      "Prepare a Codex task that needs to control macOS or access files outside the configured workspace. " +
      "The paired browser control page must approve it before anything runs. Do not use this for work fully inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TASK_LENGTH,
          description: "A precise description of the Mac action and its intended result.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
] as const;

async function runConfirmedCodexTask(
  task: string,
  workspace: string,
): Promise<{ summary: string }> {
  const temporary = await mkdtemp(join(tmpdir(), "openhome-codex-task-"));
  const outputFile = join(temporary, "last-message.txt");
  const prompt =
    "This Mac task was explicitly approved in the paired OpenHome browser control page. " +
    "Perform only the requested task and do not broaden its scope. Avoid destructive changes unless the request " +
    `explicitly requires them. Task: ${task}`;
  try {
    const result = await runProcess(
      "codex",
      [
        "exec",
        "--sandbox", "danger-full-access",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color", "never",
        "--cd", workspace,
        "--output-last-message", outputFile,
        prompt,
      ],
      workspace,
      DEFAULT_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(`The approved Codex Mac task failed with exit code ${result.code}.`);
    }
    const summary = (await readFile(outputFile, "utf8").catch(() => "")).trim();
    return { summary: summary || "The approved Mac task completed." };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-32_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The approved Codex Mac task timed out."));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && stderr.trim()) {
        reject(new Error(`The approved Codex Mac task failed: ${stderr.trim().slice(-1_000)}`));
        return;
      }
      resolve({ code });
    });
  });
}

function parseTask(args: Record<string, unknown>): string {
  const task = args["task"];
  if (typeof task !== "string" || !task.trim() || task.length > MAX_TASK_LENGTH) {
    throw new TypeError(`task must be a non-empty string of at most ${MAX_TASK_LENGTH} characters.`);
  }
  return task.trim();
}

function parsePendingTask(output: unknown, workspace: string): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new TypeError("Pending Codex Mac task is invalid.");
  }
  const record = output as Record<string, unknown>;
  if (record["operation"] !== MAC_TASK_OPERATION || record["workspace"] !== workspace) {
    throw new TypeError("Pending Codex Mac task scope does not match this server.");
  }
  return parseTask({ task: record["task"] });
}

function parseApproved(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Confirmation must be an object.");
  }
  const approved = (value as Record<string, unknown>)["approved"];
  if (typeof approved !== "boolean") throw new TypeError("confirmation.approved must be a boolean.");
  return approved;
}

function conciseSpeech(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) return "The approved Mac task completed.";
  return normalized.length <= 600 ? normalized : `${normalized.slice(0, 597)}...`;
}
