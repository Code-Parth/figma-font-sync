import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonFile } from "../../src/config/store";

type Counter = { count: number; seen: number[] };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "font-sync-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const empty = (): Counter => ({ count: 0, seen: [] });

describe("JsonFile", () => {
  it("reads the fallback when the file is missing", async () => {
    const file = new JsonFile(path.join(dir, "missing.json"), empty);
    expect(await file.read()).toEqual({ count: 0, seen: [] });
  });

  it("reads the fallback when the file is not JSON", async () => {
    const target = path.join(dir, "broken.json");
    await writeFile(target, "{ not json");
    expect(await new JsonFile(target, empty).read()).toEqual({ count: 0, seen: [] });
  });

  it("creates missing parent directories and round-trips the value", async () => {
    const target = path.join(dir, "a", "b", "state.json");
    const file = new JsonFile(target, empty);
    await file.write({ count: 3, seen: [1] });
    expect(await file.read()).toEqual({ count: 3, seen: [1] });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ count: 3, seen: [1] });
  });

  it("replaces atomically and leaves no temp files", async () => {
    const target = path.join(dir, "state.json");
    const file = new JsonFile(target, empty);
    await file.write({ count: 1, seen: [] });
    await file.write({ count: 2, seen: [] });
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(await file.read()).toEqual({ count: 2, seen: [] });
  });

  it("keeps every one of 50 concurrent updates", async () => {
    const file = new JsonFile(path.join(dir, "state.json"), empty);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        file.update((draft) => {
          draft.count += 1;
          draft.seen.push(i);
        }),
      ),
    );
    const stored = await file.read();
    expect(stored.count).toBe(50);
    expect(stored.seen.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(results.at(-1)).toEqual(stored);
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("returns the replacement when fn returns one", async () => {
    const file = new JsonFile(path.join(dir, "state.json"), empty);
    const stored = await file.update(() => ({ count: 9, seen: [9] }));
    expect(stored).toEqual({ count: 9, seen: [9] });
    expect(await file.read()).toEqual({ count: 9, seen: [9] });
  });

  it("keeps working after an update throws", async () => {
    const file = new JsonFile(path.join(dir, "state.json"), empty);
    await expect(
      file.update(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await file.update((draft) => void (draft.count = 1))).toEqual({ count: 1, seen: [] });
  });

  it("orders a write after updates already queued", async () => {
    const file = new JsonFile(path.join(dir, "state.json"), empty);
    const pending = file.update((draft) => void (draft.count = 1));
    await file.write({ count: 2, seen: [] });
    await pending;
    expect((await file.read()).count).toBe(2);
  });

  it.skipIf(process.platform === "win32")("writes with mode 0600 by default", async () => {
    const target = path.join(dir, "secret.json");
    await new JsonFile(target, empty).write({ count: 1, seen: [] });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });
});
