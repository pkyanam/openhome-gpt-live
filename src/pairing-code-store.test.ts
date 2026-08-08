import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonFileStore } from "./file-store.ts";
import { PairingCodeStore, type PairingCodeRecord } from "./pairing-code-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("PairingCodeStore", () => {
  test("keeps only a short-lived local copy and removes it after pairing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openhome-pairing-code-"));
    temporaryDirectories.push(directory);
    let now = 1_000;
    const inbox = new PairingCodeStore(
      new JsonFileStore<PairingCodeRecord>(join(directory, "codes.json"), () => now),
      () => now,
    );
    await inbox.record({
      deviceId: "dev_1",
      deviceName: "Kitchen",
      code: "12345678",
      setupUrl: "https://voice.example.test/setup",
    });
    expect((await inbox.latest())?.code).toBe("12345678");
    await inbox.remove("dev_1");
    expect(await inbox.latest()).toBeUndefined();

    await inbox.record({
      deviceId: "dev_2",
      deviceName: "Office",
      code: "87654321",
      setupUrl: "https://voice.example.test/setup",
    });
    now += 16 * 60 * 1_000;
    expect(await inbox.latest()).toBeUndefined();
  });
});
