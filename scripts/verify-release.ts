import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFile(resolve(root, path), "utf8");
const packageJson = JSON.parse(await read("package.json")) as { version?: string };
const pluginJson = JSON.parse(await read(".codex-plugin/plugin.json")) as { version?: string };
const version = packageJson.version;

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("package.json must contain a stable semantic release version.");
}
if (pluginJson.version !== version) {
  throw new Error(`Plugin version ${pluginJson.version ?? "missing"} does not match package version ${version}.`);
}

const [server, changelog, issueTemplate] = await Promise.all([
  read("src/server.ts"),
  read("CHANGELOG.md"),
  read(".github/ISSUE_TEMPLATE/bug.yml"),
]);
if (!server.includes(`version: "${version}"`)) {
  throw new Error(`The health endpoint does not report ${version}.`);
}
if (!changelog.includes(`## ${version} -`)) {
  throw new Error(`CHANGELOG.md has no ${version} release heading.`);
}
if (!issueTemplate.includes(`placeholder: v${version} or commit SHA`)) {
  throw new Error(`The bug template does not point reporters at v${version}.`);
}

console.log(`Release metadata is consistent at ${version}.`);
