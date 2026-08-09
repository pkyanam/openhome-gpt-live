import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { readEnvFile } from "./env-file.ts";

const root = resolve(import.meta.dir, "..");

describe("setup CLI", () => {
  test("documents installer and configuration modes without side effects", async () => {
    const installer = Bun.spawnSync(["bash", "install.sh", "--help"], { cwd: root });
    const setup = Bun.spawnSync([process.execPath, "scripts/setup.ts", "--help"], { cwd: root });
    expect(installer.exitCode).toBe(0);
    expect(installer.stdout.toString()).toContain("--tunnel cloudflare");
    expect(installer.stdout.toString()).toContain("--non-interactive");
    expect(setup.exitCode).toBe(0);
    expect(setup.stdout.toString()).toContain("existing, cloudflare, quick, or later");
  });

  test("supports deferred setup and preserves generated secrets on rerun", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openhome-gpt-setup-idempotent-"));
    const envPath = join(directory, ".env");
    const workspace = join(directory, "workspace");
    try {
      const environment = {
        ...process.env,
        OPENHOME_GPT_ENV_FILE: envPath,
        APP_ALLOWED_CHATGPT_EMAIL: "",
        PUBLIC_BASE_URL: "",
        CODEX_WORKSPACE: workspace,
        CODEX_MAC_CONTROL: "disabled",
        OPENHOME_API_KEY: "",
        LWC_SECRET: "",
        DEVKIT_BOOTSTRAP_TOKEN: "",
      };
      for (let run = 0; run < 2; run += 1) {
        const result = Bun.spawnSync([
          process.execPath,
          "scripts/setup.ts",
          "--non-interactive",
          "--tunnel",
          "later",
        ], { cwd: root, env: environment });
        expect(result.exitCode).toBe(0);
      }

      const values = await readEnvFile(envPath);
      expect(values.PUBLIC_BASE_URL).toBe("");
      expect(values.APP_ALLOWED_CHATGPT_EMAIL).toBe("");
      expect(values.LWC_SECRET).toHaveLength(64);
      expect(values.DEVKIT_BOOTSTRAP_TOKEN).toHaveLength(64);
      const firstSource = await readFile(envPath, "utf8");

      const third = Bun.spawnSync([
        process.execPath,
        "scripts/setup.ts",
        "--non-interactive",
        "--tunnel",
        "later",
      ], { cwd: root, env: environment });
      expect(third.exitCode).toBe(0);
      expect(await readFile(envPath, "utf8")).toBe(firstSource);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
