import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("non-interactive setup", () => {
  test("does not consume a piped installer's remaining stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openhome-gpt-setup-pipe-"));
    try {
      const child = Bun.spawn([process.execPath, "scripts/setup.ts", "--non-interactive"], {
        cwd: resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          OPENHOME_GPT_ENV_FILE: join(directory, ".env"),
          APP_ALLOWED_CHATGPT_EMAIL: "pipe-test@example.com",
          PUBLIC_BASE_URL: "https://voice.example.com",
          CODEX_WORKSPACE: join(directory, "workspace"),
          CODEX_MAC_CONTROL: "disabled",
          OPENHOME_API_KEY: "",
          LWC_SECRET: "a".repeat(64),
          DEVKIT_BOOTSTRAP_TOKEN: "b".repeat(64),
          GPT_LIVE_PERSONALITY_PROMPT: "",
          LWC_ALLOWED_MODELS: "",
          LWC_DEFAULT_MODEL: "",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write("SENTINEL_INSTALLER_LINE\n");
      await child.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).not.toContain("SENTINEL_INSTALLER_LINE");
      expect(await Bun.file(join(directory, ".env")).exists()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
