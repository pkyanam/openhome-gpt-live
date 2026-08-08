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
body.set("name", "OpenHome GPT Live");
body.set("category", "local");
body.set("description", "Wake-word GPT Live voice with Codex tool access on an OpenHome DevKit.");
body.set("trigger_words", "gpt live diagnostics");
body.set("zip_file", Bun.file(zipPath), "openhome-gpt-live-ability.zip");

const response = await fetch(`${apiBase}/api/capabilities/add-capability/`, {
  method: "POST",
  headers: { "X-API-KEY": apiKey },
  body,
  signal: AbortSignal.timeout(60_000),
});
const responseText = await response.text();
if (!response.ok) {
  if (/same name already exists/i.test(responseText)) {
    console.log("OpenHome GPT Live already exists in My Abilities; no duplicate was created.");
    console.log("For an upgrade, upload the release ZIP in the existing Ability editor and then Sync Abilities.");
    process.exit(0);
  }
  console.error(`OpenHome upload failed (HTTP ${response.status}): ${responseText.slice(0, 800)}`);
  process.exit(1);
}

console.log("OpenHome GPT Live was uploaded to My Abilities.");
console.log("Open the OpenHome dashboard to link its two Third Party Keys, install it, and restart the Agent.");
