import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { readEnvFile } from "./env-file.ts";

const projectRoot = resolve(import.meta.dir, "..");
const envPath = process.env.OPENHOME_GPT_ENV_FILE
  ? resolve(process.env.OPENHOME_GPT_ENV_FILE)
  : resolve(projectRoot, ".env");
const env = await readEnvFile(envPath);
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Finish OpenHome GPT Live setup

Usage:
  bun run finish
  bun run finish -- --wait=300
  bun run finish -- --print-only

Options:
  --wait=SECONDS   Pairing-code wait after the dashboard handoff (0-600; default 180)
  --print-only     Print the human steps without waiting
  -h, --help       Show this help
`);
  process.exit(0);
}

if (!env.PUBLIC_BASE_URL || !env.DEVKIT_BOOTSTRAP_TOKEN || !env.APP_ALLOWED_CHATGPT_EMAIL) {
  console.error("Setup is not complete enough to pair a speaker.");
  console.error("Run `bun run setup` and configure HTTPS plus the ChatGPT account email first.");
  process.exit(1);
}

const waitSeconds = readWaitSeconds(args);
console.log("\nFinish OpenHome GPT Live\n");
console.log("1. Open https://app.openhome.com/dashboard/settings and add these Third Party Keys.");
console.log("   Link both to the OpenHome GPT Live Ability.\n");
console.log(`   openhome_gpt_live_server_url\n   ${env.PUBLIC_BASE_URL}\n`);
console.log(`   openhome_gpt_live_bootstrap_token\n   ${env.DEVKIT_BOOTSTRAP_TOKEN}\n`);
console.log("2. In My Abilities, install and enable OpenHome GPT Live on the active Agent.");
console.log("   If it is not already uploaded, use dist/openhome-gpt-live-ability.zip.");
console.log("3. Tap Sync Abilities, restart the Agent, then send `gpt live diagnostics` once in Activity.");
console.log("   That one message bootstraps firmware 1.0.8; normal voice requests use Juniper.\n");

if (args.includes("--print-only")) {
  console.log("When those steps are complete, run `bun run finish` to retrieve the pairing link.");
  process.exit(0);
}

const input = !process.stdin.isTTY ? createReadStream("/dev/tty") : process.stdin;
const prompts = createInterface({ input, output: process.stdout, terminal: true });
try {
  await prompts.question("Press Enter after Sync, Restart Agent, and diagnostics are complete… ");
} finally {
  prompts.close();
  if (input !== process.stdin) input.close();
}

const child = Bun.spawn([
  process.execPath,
  "scripts/pairing-code.ts",
  `--wait=${waitSeconds}`,
], {
  cwd: projectRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);

console.log("Open the printed link in any trusted browser, pair the DevKit, and complete ChatGPT device authorization.");
console.log("The browser is only a setup/control surface; live audio remains on the speaker.");

function readWaitSeconds(values: string[]): number {
  const value = values.find((entry) => entry.startsWith("--wait="))?.slice(7);
  if (value === undefined) return 180;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 600) {
    throw new TypeError("--wait must be an integer from 0 through 600 seconds.");
  }
  return seconds;
}
