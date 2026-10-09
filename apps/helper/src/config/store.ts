import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Face } from "../fonts/types";

export type PairedClient = {
  id: string;
  name: string;
  /** Hex sha256 of the bearer token. The token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type Config = { libraryFolderId: string | null; pairedClients: PairedClient[] };

export type InstalledFile = {
  fileId: string;
  md5: string;
  /** Library file name, for display. */
  name: string;
  paths: string[];
  /** Windows HKCU Fonts value names written for this file; empty elsewhere. */
  registryValues: string[];
  faces: Face[];
  installedAt: string;
};

export type InstalledState = {
  files: Record<string, InstalledFile>;
  /** Files that could not be deleted yet (Windows keeps loaded fonts locked). Retried at startup. */
  pendingDeletes: string[];
};

/** Cache of parsed faces keyed by `${fileId}:${md5}`. Safe to lose. */
export type FacesCache = Record<string, { faces: Face[]; error: string | null }>;

/** What consumers depend on, so tests can use an in-memory fake. */
export interface Store<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
  /** `fn` may mutate the draft in place or return a replacement. Returns the stored value. */
  update(fn: (draft: T) => T | void): Promise<T>;
}

/**
 * A JSON document on disk. Writes are atomic (temp file + rename) and `update` calls are serialized
 * within the process, so concurrent API requests cannot interleave read-modify-write cycles.
 * A missing or unparsable file reads as `fallback()`.
 */
export class JsonFile<T> implements Store<T> {
  /** Tail of the write queue. Settled values are dropped so one failure does not poison later writes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly fallback: () => T,
    private readonly mode: number = 0o600,
  ) {}

  async read(): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.fallback();
      throw error;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return this.fallback();
    }
  }

  async write(value: T): Promise<void> {
    // Queued behind pending updates, otherwise an update that read before this write would overwrite it.
    await this.enqueue(() => this.replace(value));
  }

  /** `fn` may mutate the draft in place or return a replacement. Returns the stored value. */
  async update(fn: (draft: T) => T | void): Promise<T> {
    return this.enqueue(async () => {
      const draft = await this.read();
      const value = fn(draft) ?? draft;
      await this.replace(value);
      return value;
    });
  }

  private enqueue<R>(task: () => Promise<R>): Promise<R> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async replace(value: T): Promise<void> {
    const dir = path.dirname(this.path);
    await mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(this.path)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const handle = await open(temp, "wx", this.mode);
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
        // Without the flush a crash right after the rename can leave an empty file on some filesystems.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
