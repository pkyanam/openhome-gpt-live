import { JsonFileStore } from "./file-store.ts";

export const PAIRING_CODE_TTL_MS = 15 * 60 * 1_000;

export interface PairingCodeRecord {
  deviceId: string;
  deviceName: string;
  code: string;
  setupUrl: string;
  createdAt: number;
  expiresAt: number;
}

/** Private, short-lived inbox used only by the local pairing-code helper. */
export class PairingCodeStore {
  constructor(
    private readonly store: JsonFileStore<PairingCodeRecord>,
    private readonly now: () => number = Date.now,
  ) {
    void this.scheduleExisting();
  }

  async record(input: Omit<PairingCodeRecord, "createdAt" | "expiresAt">): Promise<PairingCodeRecord> {
    const record: PairingCodeRecord = {
      ...input,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_CODE_TTL_MS,
    };
    await this.store.set(record.deviceId, record, { ttlMs: PAIRING_CODE_TTL_MS });
    this.scheduleCleanup(record);
    return record;
  }

  private async scheduleExisting(): Promise<void> {
    for (const [, record] of await this.store.entries()) this.scheduleCleanup(record);
  }

  private scheduleCleanup(record: PairingCodeRecord): void {
    const cleanup = setTimeout(() => {
      void this.store.get(record.deviceId).then((current) => {
        if (current?.code === record.code) return this.store.delete(record.deviceId);
      });
    }, Math.max(0, record.expiresAt - this.now()));
    cleanup.unref?.();
  }

  remove(deviceId: string): Promise<void> {
    return this.store.delete(deviceId);
  }

  async latest(): Promise<PairingCodeRecord | undefined> {
    const entries = await this.store.entries();
    return entries
      .map(([, record]) => record)
      .filter((record) => record.expiresAt > this.now())
      .sort((left, right) => right.createdAt - left.createdAt)[0];
  }
}
