import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonFileStore } from "./file-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("JsonFileStore", () => {
  test("persists cloned values in a private file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "sessions.json");
    const store = new JsonFileStore<{ state: string }>(path);
    const value = { state: "pending" };
    await store.set("one", value);
    value.state = "changed-outside-store";

    const reloaded = new JsonFileStore<{ state: string }>(path);
    expect(await reloaded.get("one")).toEqual({ state: "pending" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  test("expires entries and removes them from disk", async () => {
    let now = 1_000;
    const directory = await temporaryDirectory();
    const path = join(directory, "sessions.json");
    const store = new JsonFileStore<string>(path, () => now);
    await store.set("short", "value", { ttlMs: 50 });
    now += 51;

    expect(await store.get("short")).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8")).entries).toEqual({});
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openhome-gpt-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
