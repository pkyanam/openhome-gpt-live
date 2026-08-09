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
const releaseZipPath = resolve(projectRoot, "dist", "openhome-gpt-live-release.zip");
const abilityName = "OpenHome GPT Live";
const packageVersion = (await Bun.file(resolve(projectRoot, "package.json")).json() as { version?: string }).version || "current";

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

const abilities = await fetchAbilities();
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
if (existingId === undefined) {
  body.set("zip_file", Bun.file(zipPath), "openhome-gpt-live-ability.zip");
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

if (existingId === undefined) {
  console.log("OpenHome GPT Live was uploaded to My Abilities.");
  console.log("Open the OpenHome dashboard to link its Third Party Keys, install it, Sync Abilities, and restart the Agent.");
  process.exit(0);
}

// Editing Ability metadata does not replace the current draft ZIP. OpenHome's
// editor uses this separate endpoint, and it expects files at the ZIP root.
const refreshed = await fetchAbilities();
const refreshedAbility = refreshed.find((value): value is Record<string, unknown> =>
  isRecord(value) && value.id === existingId);
const versions = Array.isArray(refreshedAbility?.capability_versions)
  ? refreshedAbility.capability_versions.filter(isRecord)
  : [];
const draft = versions
  .filter((version) => version.is_committed === false)
  .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0];
const draftId = draft?.id;
if (typeof draftId !== "number" || !Number.isInteger(draftId)) {
  console.error("OpenHome did not expose an editable Ability draft for this upgrade.");
  process.exit(1);
}

const releaseBody = new FormData();
releaseBody.set("zip_file", Bun.file(releaseZipPath), "openhome-gpt-live-release.zip");
releaseBody.set("committed", "true");
releaseBody.set("commit_message", `OpenHome GPT Live ${packageVersion}`);
const releaseResponse = await fetch(
  `${apiBase}/api/capabilities/validate/release-code/${draftId}/`,
  {
    method: "POST",
    headers: { "X-API-KEY": apiKey },
    body: releaseBody,
    signal: AbortSignal.timeout(60_000),
  },
);
const releaseText = await releaseResponse.text();
if (!releaseResponse.ok) {
  console.error(`OpenHome release upload failed (HTTP ${releaseResponse.status}): ${releaseText.slice(0, 800)}`);
  process.exit(1);
}

const committedAbilities = await fetchAbilities();
const committedAbility = committedAbilities.find((value): value is Record<string, unknown> =>
  isRecord(value) && value.id === existingId);
const committedVersions = Array.isArray(committedAbility?.capability_versions)
  ? committedAbility.capability_versions.filter(isRecord)
  : [];
const committedRelease = committedVersions.find((version) => version.id === draftId);
const enabledRelease = committedVersions.find((version) => version.is_user_enabled === true);
if (committedRelease?.is_committed !== true || !enabledRelease) {
  console.error("OpenHome accepted the release ZIP but did not publish an enabled working version.");
  process.exit(1);
}

console.log(`OpenHome GPT Live ${packageVersion} was committed in place; linked Third Party Keys were preserved.`);
console.log("Next, run `bun run ability:prepare-sync`.");
console.log("Firmware 1.1.1 syncs and restarts automatically; firmware 1.0.8 then asks for dashboard Sync and Agent restart.");

async function fetchAbilities(): Promise<unknown[]> {
  const listResponse = await fetch(`${apiBase}/api/capabilities/get-all-capabilities/`, {
    headers: { "X-API-KEY": apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!listResponse.ok) {
    console.error(`Could not inspect existing OpenHome Abilities (HTTP ${listResponse.status}).`);
    process.exit(1);
  }
  const values = await listResponse.json() as unknown;
  if (!Array.isArray(values)) {
    console.error("OpenHome returned an invalid Ability list.");
    process.exit(1);
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
