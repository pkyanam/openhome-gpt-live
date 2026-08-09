import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readEnvFile } from "./env-file.ts";

type Level = "ok" | "warn" | "fail";
const results: Array<{ level: Level; label: string; detail: string }> = [];
const projectRoot = resolve(import.meta.dir, "..");
const envPath = process.env.OPENHOME_GPT_ENV_FILE
  ? resolve(process.env.OPENHOME_GPT_ENV_FILE)
  : resolve(projectRoot, ".env");
const env = await readEnvFile(envPath);
const requireServer = process.argv.includes("--require-server");
const requireCodex = process.argv.includes("--require-codex");
const requireConfig = requireServer || process.argv.includes("--require-config");
const offline = process.argv.includes("--offline");

checkCommand("Bun", "bun", ["--version"]);
checkCommand("Python", "python3", ["--version"], "warn");
checkCommand("Codex", "codex", ["--version"], requireCodex ? "fail" : "warn");
checkCommand("Codex login", "codex", ["login", "status"], requireCodex ? "fail" : "warn");
checkCommand("Codex GPT Live support", "codex", ["--enable", "realtime_conversation", "app-server", "--help"], requireCodex ? "fail" : "warn");

checkValue("Private signing secret", (env.LWC_SECRET ?? "").length >= 32, "LWC_SECRET is at least 32 characters");
checkValue("DevKit enrollment secret", (env.DEVKIT_BOOTSTRAP_TOKEN ?? "").length >= 32, "DEVKIT_BOOTSTRAP_TOKEN is at least 32 characters");
checkValue("Authorized ChatGPT identity", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.APP_ALLOWED_CHATGPT_EMAIL ?? ""), "APP_ALLOWED_CHATGPT_EMAIL is configured", requireConfig ? "fail" : "warn");
checkValue("Public URL", validHttpsOrigin(env.PUBLIC_BASE_URL), env.PUBLIC_BASE_URL || "PUBLIC_BASE_URL is missing", requireConfig ? "fail" : "warn");

if (env.CODEX_WORKSPACE) {
  try {
    await access(env.CODEX_WORKSPACE);
    results.push({ level: "ok", label: "Codex workspace", detail: env.CODEX_WORKSPACE });
  } catch {
    results.push({ level: "fail", label: "Codex workspace", detail: `${env.CODEX_WORKSPACE} is not accessible` });
  }
} else {
  results.push({ level: "fail", label: "Codex workspace", detail: "CODEX_WORKSPACE is missing" });
}

const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
if (pythonAvailable) {
  const packageResult = spawnSync("python3", ["scripts/package-ability.py"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  results.push(packageResult.status === 0
    ? { level: "ok", label: "Ability package", detail: packageResult.stdout.trim() }
    : { level: "fail", label: "Ability package", detail: packageResult.stderr.trim() || "packaging failed" });
} else {
  try {
    await access(resolve(projectRoot, "dist", "openhome-gpt-live-ability.zip"));
    results.push({ level: "ok", label: "Ability package", detail: "using the prebuilt release asset" });
  } catch {
    results.push({ level: "warn", label: "Ability package", detail: "Python is unavailable and no prebuilt ZIP is present" });
  }
}

if (!offline) {
  await checkHealth("Local bridge", `http://127.0.0.1:${env.PORT || "3000"}/healthz`, requireServer ? "fail" : "warn");
  if (validHttpsOrigin(env.PUBLIC_BASE_URL)) {
    await checkHealth("Public bridge", `${env.PUBLIC_BASE_URL}/healthz`, requireServer ? "fail" : "warn");
  }
}

console.log("\nOpenHome GPT Live doctor\n");
for (const result of results) {
  const mark = result.level === "ok" ? "✓" : result.level === "warn" ? "!" : "✗";
  console.log(`${mark} ${result.label}: ${result.detail}`);
}
const failures = results.filter((result) => result.level === "fail");
const warnings = results.filter((result) => result.level === "warn");
console.log(`\n${failures.length} failed, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`);
if (failures.length > 0) process.exitCode = 1;

function checkCommand(label: string, command: string, args: string[], failureLevel: "warn" | "fail" = "fail"): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const detail = (result.stdout || result.stderr || "").trim().split("\n")[0] || `${command} is available`;
  results.push(result.status === 0
    ? { level: "ok", label, detail }
    : { level: failureLevel, label, detail: `${command} is missing or incompatible` });
}

function checkValue(label: string, condition: boolean, detail: string, failureLevel: "warn" | "fail" = "fail"): void {
  results.push(condition
    ? { level: "ok", label, detail }
    : { level: failureLevel, label, detail });
}

async function checkHealth(label: string, url: string, failureLevel: "warn" | "fail"): Promise<void> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const payload = await response.json() as { status?: string };
    if (!response.ok || payload.status !== "ok") throw new Error(`HTTP ${response.status}`);
    results.push({ level: "ok", label, detail: url });
  } catch {
    results.push({ level: failureLevel, label, detail: `${url} is not reachable` });
  }
}

function validHttpsOrigin(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && url.origin === value?.replace(/\/$/, "");
  } catch {
    return false;
  }
}
