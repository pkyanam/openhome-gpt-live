import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type EnvValues = Record<string, string>;

export async function readEnvFile(path: string): Promise<EnvValues> {
  let source = "";
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  const values: EnvValues = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match?.[1]) continue;
    values[match[1]] = decodeEnvValue(match[2] ?? "");
  }
  return values;
}

export async function writePrivateEnvFile(
  path: string,
  values: EnvValues,
  comments: readonly string[] = [],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const body = [
    ...comments.map((line) => line ? `# ${line}` : ""),
    ...Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    "",
  ].join("\n");
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function decodeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "");
}
