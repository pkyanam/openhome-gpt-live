import { resolve } from "node:path";
import { readEnvFile } from "./env-file.ts";

const projectRoot = resolve(import.meta.dir, "..");
const envPath = process.env.OPENHOME_GPT_ENV_FILE
  ? resolve(process.env.OPENHOME_GPT_ENV_FILE)
  : resolve(projectRoot, ".env");
const env = await readEnvFile(envPath);
const apiKey = process.env.OPENHOME_API_KEY?.trim() || env.OPENHOME_API_KEY?.trim();
const apiBase = (process.env.OPENHOME_API_BASE?.trim() || env.OPENHOME_API_BASE?.trim() || "https://app.openhome.com").replace(/\/$/, "");
const zipPath = resolve(projectRoot, "dist", "openhome-gpt-live-ability.zip");
const abilityName = "OpenHome GPT Live";

if (!apiKey) {
  console.error("OPENHOME_API_KEY is not configured. Run `bun run setup`, or upload the ZIP manually.");
  process.exit(1);
}

const packageProcess = Bun.spawnSync(["python3", "scripts/package-ability.py"], {
  cwd: projectRoot,
  stdout: "pipe",
  stderr: "pipe",
});
if (packageProcess.exitCode !== 0) {
  console.error(new TextDecoder().decode(packageProcess.stderr));
  process.exit(1);
}

const body = new FormData();
body.set("name", abilityName);
body.set("category", "local");
body.set("description", "Wake-word GPT Live voice with Codex tool access on an OpenHome DevKit.");
body.set("trigger_words", "gpt live diagnostics");
body.set("zip_file", Bun.file(zipPath), "openhome-gpt-live-ability.zip");

const listResponse = await fetch(`${apiBase}/api/capabilities/get-all-capabilities/`, {
  headers: { "X-API-KEY": apiKey },
  signal: AbortSignal.timeout(30_000),
});
if (!listResponse.ok) {
  console.error(`Could not inspect existing OpenHome Abilities (HTTP ${listResponse.status}).`);
  process.exit(1);
}
const abilities = await listResponse.json() as unknown;
if (!Array.isArray(abilities)) {
  console.error("OpenHome returned an invalid Ability list.");
  process.exit(1);
}
const existing = abilities.find((value): value is Record<string, unknown> =>
  isRecord(value) && value.name === abilityName);
const existingId = existing?.id;
if (existing && (typeof existingId !== "number" || !Number.isInteger(existingId))) {
  console.error("The existing OpenHome Ability has no valid id.");
  process.exit(1);
}
if (Array.isArray(existing?.selected_keys)) {
  body.set("selected_keys", JSON.stringify(existing.selected_keys));
}

const response = await fetch(
  existingId === undefined
    ? `${apiBase}/api/capabilities/add-capability/`
    : `${apiBase}/api/capabilities/edit-capability/${existingId}/`,
  {
  method: existingId === undefined ? "POST" : "PUT",
  headers: { "X-API-KEY": apiKey },
  body,
  signal: AbortSignal.timeout(60_000),
  },
);
const responseText = await response.text();
if (!response.ok) {
  console.error(`OpenHome upload failed (HTTP ${response.status}): ${responseText.slice(0, 800)}`);
  process.exit(1);
}

console.log(existingId === undefined
  ? "OpenHome GPT Live was uploaded to My Abilities."
  : "OpenHome GPT Live was upgraded in place; linked Third Party Keys were preserved.");
console.log(existingId === undefined
  ? "Open the OpenHome dashboard to link its two Third Party Keys, install it, Sync Abilities, and restart the Agent."
  : "In OpenHome, tap Sync Abilities and then restart the Agent to install this upgrade on the speaker.");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
