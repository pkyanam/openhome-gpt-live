import { resolve } from "node:path";
import { readEnvFile } from "./env-file.ts";
import { JsonFileStore } from "../src/file-store.ts";
import { PairingCodeStore, type PairingCodeRecord } from "../src/pairing-code-store.ts";

const projectRoot = resolve(import.meta.dir, "..");
const envPath = process.env.OPENHOME_GPT_ENV_FILE
  ? resolve(process.env.OPENHOME_GPT_ENV_FILE)
  : resolve(projectRoot, ".env");
const env = await readEnvFile(envPath);
const configuredDataDirectory = process.env.OPENHOME_GPT_DATA_DIR?.trim()
  || env.OPENHOME_GPT_DATA_DIR?.trim()
  || "data";
const dataDirectory = resolve(projectRoot, configuredDataDirectory);
const inbox = new PairingCodeStore(
  new JsonFileStore<PairingCodeRecord>(resolve(dataDirectory, "pairing-codes.json")),
);
const waitSeconds = readWaitSeconds(process.argv.slice(2));
const deadline = Date.now() + waitSeconds * 1_000;

if (waitSeconds > 0 && !await inbox.latest()) {
  console.log(`Waiting up to ${waitSeconds} seconds for an OpenHome DevKit to register…`);
}

let pairing = await inbox.latest();
while (!pairing && Date.now() < deadline) {
  await Bun.sleep(1_000);
  pairing = await inbox.latest();
}

if (!pairing) {
  console.error("No unpaired DevKit code is available.");
  console.error("Install or Sync the Ability, restart the OpenHome Agent, then run this command again.");
  process.exit(1);
}

const grouped = `${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}`;
const setup = new URL(pairing.setupUrl);
setup.hash = new URLSearchParams({ pairing: pairing.code }).toString();
console.log(`\n${pairing.deviceName} pairing code: ${grouped}`);
console.log(`Open this one-click setup link:\n${setup.toString()}\n`);
console.log(`This code expires at ${new Date(pairing.expiresAt).toLocaleTimeString()}.`);

function readWaitSeconds(args: string[]): number {
  const value = args.find((entry) => entry.startsWith("--wait="))?.slice("--wait=".length);
  if (value === undefined) return 0;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 600) {
    throw new TypeError("--wait must be an integer from 0 through 600 seconds.");
  }
  return seconds;
}
