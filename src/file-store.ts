import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeyValueStore } from "@opencoredev/loginwithchatgpt-core";

interface PersistedEntry<T> {
  value: T;
  expiresAt?: number;
}

interface PersistedFile<T> {
  version: 1;
  entries: Record<string, PersistedEntry<T>>;
}

/** Small single-process JSON store for a single DevKit deployment. */
export class JsonFileStore<T> implements KeyValueStore<T> {
  private readonly data = new Map<string, PersistedEntry<T>>();
  private readonly ready: Promise<void>;
  private writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.ready = this.load();
  }

  async get(key: string): Promise<T | undefined> {
    await this.ready;
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      await this.persist();
      return undefined;
    }
    return structuredClone(entry.value);
  }

  async set(key: string, value: T, options?: { ttlMs?: number }): Promise<void> {
    await this.ready;
    this.data.set(key, {
      value: structuredClone(value),
      ...(options?.ttlMs === undefined ? {} : { expiresAt: this.now() + options.ttlMs }),
    });
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    if (!this.data.delete(key)) return;
    await this.persist();
  }

  async entries(): Promise<Array<[string, T]>> {
    await this.ready;
    let removedExpired = false;
    const result: Array<[string, T]> = [];
    for (const [key, entry] of this.data) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
        this.data.delete(key);
        removedExpired = true;
      } else {
        result.push([key, structuredClone(entry.value)]);
      }
    }
    if (removedExpired) await this.persist();
    return result;
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<PersistedFile<T>>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      throw new Error(`Unsupported state file format: ${this.filePath}`);
    }
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== "object" || !("value" in entry)) continue;
      this.data.set(key, entry as PersistedEntry<T>);
    }
  }

  private persist(): Promise<void> {
    const snapshot: PersistedFile<T> = {
      version: 1,
      entries: Object.fromEntries(this.data),
    };
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
