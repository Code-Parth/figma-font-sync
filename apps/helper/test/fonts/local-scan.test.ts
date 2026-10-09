import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type LocalFace, scanLocalFonts } from "../../src/fonts/local-scan";
import { MAX_FONT_BYTES } from "../../src/fonts/sfnt";
import { buildCollection, buildFont } from "../support/font-builder";

let dir: string;
let cacheFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "font-sync-scan-"));
  cacheFile = path.join(dir, "cache", "nested", "local-fonts.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Permission tricks do nothing for root, and Windows needs privileges for symlinks.
const posixUser = process.platform !== "win32" && process.getuid?.() !== 0;

const font = (family: string, style = "Regular") => buildFont({ names: { 1: family, 2: style } });
// Forward slashes on every OS, so the expectations below read the same on Windows.
const relative = (file: string) => path.relative(dir, file).split(path.sep).join("/");
const summary = (faces: LocalFace[]) =>
  faces.map((f) => `${relative(f.path)} ${f.face.family}/${f.face.style}${f.system ? " system" : ""}`);
const readCache = async () =>
  JSON.parse(await readFile(cacheFile, "utf8")) as { version: number; files: Record<string, { error: string | null }> };

async function put(relative: string, bytes: Uint8Array | string): Promise<string> {
  const file = path.join(dir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

/** Whole seconds, so the cached mtimeMs can be reproduced exactly after rewriting a file. */
async function setMtime(file: string, seconds: number): Promise<void> {
  await utimes(file, seconds, seconds);
}

describe("scanLocalFonts", () => {
  it("walks nested directories, matches extensions case-insensitively and skips invalid files", async () => {
    await put("user/A.ttf", font("Alpha"));
    await put("user/sub/B.OTF", buildFont({ names: { 1: "Beta", 2: "Bold" }, flavor: "otf" }));
    await put("user/sub/deeper/C.ttc", buildCollection([{ names: { 1: "Gamma" } }, { names: { 1: "Gamma", 2: "Italic" } }]));
    await put("user/D.otc", buildCollection([{ names: { 1: "Delta" } }]));
    await put("user/notes.txt", font("Ignored"));
    await put("user/broken.ttf", "not a font");
    await put("user/hidden.ttf", font(".Hidden"));
    await put("system/S.ttf", font("Sigma"));

    const faces = await scanLocalFonts(
      [
        { path: path.join(dir, "user"), system: false },
        { path: path.join(dir, "missing"), system: false },
        { path: path.join(dir, "system"), system: true },
      ],
      cacheFile,
    );

    expect(summary(faces)).toEqual([
      "user/A.ttf Alpha/Regular",
      "user/D.otc Delta/Regular",
      "user/sub/B.OTF Beta/Bold",
      "user/sub/deeper/C.ttc Gamma/Regular",
      "user/sub/deeper/C.ttc Gamma/Italic",
      "system/S.ttf Sigma/Regular system",
    ]);
    const cache = await readCache();
    expect(cache.version).toBe(1);
    expect(Object.keys(cache.files).map(relative)).toEqual([
      "user/A.ttf",
      "user/D.otc",
      "user/broken.ttf",
      "user/hidden.ttf",
      "user/sub/B.OTF",
      "user/sub/deeper/C.ttc",
      "system/S.ttf",
    ]);
    expect(cache.files[path.join(dir, "user/broken.ttf")]?.error).toBe("Not a TrueType or OpenType font file.");
    expect(cache.files[path.join(dir, "user/hidden.ttf")]?.error).toBeNull();
  });

  it("lists a file once when scan roots overlap, with the first root's system flag", async () => {
    await put("fonts/inner/A.ttf", font("Alpha"));
    const faces = await scanLocalFonts(
      [
        { path: path.join(dir, "fonts", "inner"), system: true },
        { path: path.join(dir, "fonts"), system: false },
      ],
      cacheFile,
    );
    expect(summary(faces)).toEqual(["fonts/inner/A.ttf Alpha/Regular system"]);
  });

  it.skipIf(!posixUser)("follows file symlinks but never directory symlinks", async () => {
    const outside = await put("outside/O.ttf", font("Outside"));
    await put("fonts/A.ttf", font("Alpha"));
    await symlink(outside, path.join(dir, "fonts", "linked.ttf"));
    await symlink(path.join(dir, "outside"), path.join(dir, "fonts", "linked-dir"));
    // A loop back to the root would never finish if directory links were followed.
    await symlink(path.join(dir, "fonts"), path.join(dir, "fonts", "loop"));
    await symlink(path.join(dir, "nowhere.ttf"), path.join(dir, "fonts", "dangling.ttf"));

    const faces = await scanLocalFonts([{ path: path.join(dir, "fonts"), system: false }], cacheFile);
    expect(summary(faces)).toEqual(["fonts/A.ttf Alpha/Regular", "fonts/linked.ttf Outside/Regular"]);
  });

  it("re-parses only new or changed files and drops removed ones", async () => {
    const unchanged = await put("fonts/A.ttf", font("Alpha"));
    const changed = await put("fonts/B.ttf", font("Beta"));
    const removed = await put("fonts/C.ttf", font("Gamma"));
    await setMtime(unchanged, 1_700_000_000);
    await setMtime(changed, 1_700_000_000);
    const dirs = [{ path: path.join(dir, "fonts"), system: false }];
    await scanLocalFonts(dirs, cacheFile);

    // Same size and mtime but unparseable bytes: only a cache hit can still report Alpha.
    const original = await readFile(unchanged);
    await writeFile(unchanged, new Uint8Array(original.length));
    await setMtime(unchanged, 1_700_000_000);
    await writeFile(changed, font("Beta Two"));
    await setMtime(changed, 1_700_000_100);
    await rm(removed);
    await put("fonts/D.ttf", font("Delta"));

    const faces = await scanLocalFonts(dirs, cacheFile);
    expect(summary(faces)).toEqual(["fonts/A.ttf Alpha/Regular", "fonts/B.ttf Beta Two/Regular", "fonts/D.ttf Delta/Regular"]);
    expect(Object.keys((await readCache()).files).map((f) => path.basename(f))).toEqual(["A.ttf", "B.ttf", "D.ttf"]);
  });

  it("re-parses a file whose size changed even when its mtime did not", async () => {
    const file = await put("fonts/A.ttf", font("Alpha"));
    await setMtime(file, 1_700_000_000);
    const dirs = [{ path: path.join(dir, "fonts"), system: false }];
    await scanLocalFonts(dirs, cacheFile);
    await writeFile(file, font("Alpha Extended Family Name"));
    await setMtime(file, 1_700_000_000);
    expect(summary(await scanLocalFonts(dirs, cacheFile))).toEqual(["fonts/A.ttf Alpha Extended Family Name/Regular"]);
  });

  it.skipIf(!posixUser)("skips files over MAX_FONT_BYTES without reading them", async () => {
    const big = await put("fonts/big.ttf", "");
    await truncate(big, MAX_FONT_BYTES + 1);
    // Unreadable as well: an attempted read would fail and leave no cache entry.
    await chmod(big, 0o000);
    const faces = await scanLocalFonts([{ path: path.join(dir, "fonts"), system: false }], cacheFile);
    expect(faces).toEqual([]);
    expect((await readCache()).files[big]?.error).toContain("50 MB");
  });

  it.skipIf(!posixUser)("skips unreadable files without caching them, so they are retried", async () => {
    const locked = await put("fonts/locked.ttf", font("Locked"));
    await chmod(locked, 0o000);
    const dirs = [{ path: path.join(dir, "fonts"), system: false }];
    expect(await scanLocalFonts(dirs, cacheFile)).toEqual([]);
    await chmod(locked, 0o644);
    expect(summary(await scanLocalFonts(dirs, cacheFile))).toEqual(["fonts/locked.ttf Locked/Regular"]);
  });

  it("ignores a corrupt or foreign cache file and replaces it", async () => {
    await put("fonts/A.ttf", font("Alpha"));
    const dirs = [{ path: path.join(dir, "fonts"), system: false }];
    for (const content of ["{ torn", JSON.stringify({ version: 2, files: {} }), JSON.stringify({ version: 1, files: { x: 1 } })]) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, content);
      expect(summary(await scanLocalFonts(dirs, cacheFile))).toEqual(["fonts/A.ttf Alpha/Regular"]);
      expect((await readCache()).version).toBe(1);
    }
  });

  it("returns faces even when the cache cannot be written", async () => {
    await put("fonts/A.ttf", font("Alpha"));
    const blocker = await put("blocker", "a file where the cache directory should be");
    const faces = await scanLocalFonts([{ path: path.join(dir, "fonts"), system: false }], path.join(blocker, "cache.json"));
    expect(summary(faces)).toEqual(["fonts/A.ttf Alpha/Regular"]);
  });

  it("handles no directories at all", async () => {
    expect(await scanLocalFonts([], cacheFile)).toEqual([]);
  });
});
