import { resolve } from "node:path";
import { readEnvFile } from "./env-file.ts";

const projectRoot = resolve(import.meta.dir, "..");
const envPath = process.env.OPENHOME_GPT_ENV_FILE
  ? resolve(process.env.OPENHOME_GPT_ENV_FILE)
  : resolve(projectRoot, ".env");
const env = await readEnvFile(envPath);
const apiKey = process.env.OPENHOME_API_KEY?.trim() || env.OPENHOME_API_KEY?.trim();

if (!apiKey) {
  throw new Error("OPENHOME_API_KEY is required. Run `bun run setup` first.");
}

const abilityDir = "/home/openhome/openhome_devkit/local_capabilities/openhome_gpt_live";
const command = `
set -eu
systemctl --user stop openhome-gpt-live.service || true
if [ -d ${abilityDir} ]; then
  backup="${abilityDir}.upgrade-backup-$(date +%Y%m%d%H%M%S)"
  mv ${abilityDir} "$backup"
  echo "Archived cached Ability at $backup"
else
  echo "No cached OpenHome GPT Live directory was present"
fi
`.trim();

const socket = new WebSocket(
  `wss://app.openhome.com/ws/devkit/${encodeURIComponent(apiKey)}/`,
);
let commandSent = false;
let settled = false;
const timeout = setTimeout(
  () => finish(2, "Timed out waiting for the OpenHome DevKit."),
  20_000,
);

socket.addEventListener("open", () => socket.send("frontend"));
socket.addEventListener("error", () => finish(3, "Could not connect to the OpenHome DevKit."));
socket.addEventListener("message", (event) => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(String(event.data)) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message["device_status"] === "connected" && !commandSent) {
    commandSent = true;
    socket.send(JSON.stringify({ command: "exec_command", cmd: command }));
    return;
  }
  if (message["response"] !== "exec_command") return;
  const data = message["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const frame = data as Record<string, unknown>;
  if (frame["type"] === "output" && typeof frame["result"] === "string") {
    process.stdout.write(frame["result"]);
    if (!frame["result"].endsWith("\n")) process.stdout.write("\n");
  } else if (frame["type"] === "completed") {
    console.log("Reconnect the DevKit in OpenHome, tap Sync Abilities, then Restart Agent.");
    finish(0);
  }
});

function finish(code: number, error?: string): void {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (error) process.stderr.write(`${error}\n`);
  socket.close();
  setTimeout(() => process.exit(code), 50);
}
