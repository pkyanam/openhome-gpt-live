import { resolve } from "node:path";
import { readEnvFile } from "./env-file.ts";

const env = await readEnvFile(resolve(import.meta.dir, "..", ".env"));
const mode = process.argv[2] ?? "bridge";

if (mode === "bridge") {
  const ready = Boolean(
    /^https:\/\//.test(env.PUBLIC_BASE_URL ?? "")
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.APP_ALLOWED_CHATGPT_EMAIL ?? ""),
  );
  process.exit(ready ? 0 : 1);
}
if (mode === "openhome") process.exit(env.OPENHOME_API_KEY?.trim() ? 0 : 1);
throw new TypeError("Usage: bun scripts/configured.ts <bridge|openhome>");
