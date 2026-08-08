import { resolve } from "node:path";
import { readEnvFile } from "./env-file.ts";

const envPath = process.env.OPENHOME_GPT_ENV_FILE
  ? resolve(process.env.OPENHOME_GPT_ENV_FILE)
  : resolve(import.meta.dir, "..", ".env");
const env = await readEnvFile(envPath);
if (!env.PUBLIC_BASE_URL || !env.DEVKIT_BOOTSTRAP_TOKEN) {
  console.error("Run `bun run setup` first.");
  process.exit(1);
}

console.log("Add these as Third Party Keys in OpenHome and link both to OpenHome GPT Live:\n");
console.log(`openhome_gpt_live_server_url\n${env.PUBLIC_BASE_URL}\n`);
console.log(`openhome_gpt_live_bootstrap_token\n${env.DEVKIT_BOOTSTRAP_TOKEN}\n`);
console.log("Optional defaults:");
console.log("openhome_gpt_live_voice = vale");
console.log("openhome_gpt_live_wake_phrase = juniper");
