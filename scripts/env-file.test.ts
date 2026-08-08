import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { readEnvFile, writePrivateEnvFile } from "./env-file.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("private env files", () => {
  test("round-trips spaces, quotes, and empty values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openhome-gpt-env-"));
    temporaryDirectories.push(directory);
    const path = join(directory, ".env");
    await writePrivateEnvFile(path, {
      SIMPLE: "value",
      SPACES: "a value with spaces",
      QUOTES: 'say "hello"',
      EMPTY: "",
    }, ["private"]);

    expect(await readEnvFile(path)).toEqual({
      SIMPLE: "value",
      SPACES: "a value with spaces",
      QUOTES: 'say "hello"',
      EMPTY: "",
    });
    expect(await readFile(path, "utf8")).not.toContain("undefined");
  });
});
