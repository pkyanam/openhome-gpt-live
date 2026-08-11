import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { readEnvFile, writePrivateEnvFile } from "./env-file.ts";

const root = resolve(import.meta.dir, "..");
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("AgentMail setup", () => {
  test("validates one exact inbox and preserves unrelated OpenHome secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openhome-agentmail-setup-"));
    const envPath = join(directory, ".env");
    try {
      await writePrivateEnvFile(envPath, {
        LWC_SECRET: "existing-signing-secret",
        OPENHOME_SPOTIFY_TOOL_TOKEN: "existing-spotify-secret",
      });
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          expect(request.headers.get("authorization")).toBe("Bearer am_test_secret");
          expect(new URL(request.url).pathname).toBe("/v0/inboxes/speaker%40agentmail.to");
          return Response.json({
            inbox_id: "inbox_123",
            email: "speaker@agentmail.to",
          });
        },
      });
      servers.push(server);
      const child = Bun.spawn([
        process.execPath,
        "scripts/setup-agentmail.ts",
        "--non-interactive",
      ], {
        cwd: root,
        env: {
          ...process.env,
          OPENHOME_GPT_ENV_FILE: envPath,
          AGENTMAIL_API_KEY: "am_test_secret",
          AGENTMAIL_INBOX: "speaker@agentmail.to",
          AGENTMAIL_API_BASE: `http://127.0.0.1:${server.port}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).not.toContain("am_test_secret");
      const values = await readEnvFile(envPath);
      expect(values.AGENTMAIL_API_KEY).toBe("am_test_secret");
      expect(values.AGENTMAIL_INBOX).toBe("speaker@agentmail.to");
      expect(values.LWC_SECRET).toBe("existing-signing-secret");
      expect(values.OPENHOME_SPOTIFY_TOOL_TOKEN).toBe("existing-spotify-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not accept API keys on the command line", () => {
    const result = Bun.spawnSync([
      process.execPath,
      "scripts/setup-agentmail.ts",
      "--api-key",
      "must-not-be-accepted",
    ], { cwd: root });
    expect(result.exitCode).not.toBe(0);
  });
});
