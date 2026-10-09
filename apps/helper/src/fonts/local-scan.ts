import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Paths } from "../config/paths";
import { FontParseError, MAX_FONT_BYTES, parseFont } from "./sfnt";
import type { Face } from "./types";

export type LocalFace = { path: string; system: boolean; face: Face };

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc"]);

type CachedFile = { size: number; mtimeMs: number; faces: Face[]; error: string | null };
type ScanCache = { version: 1; files: Record<string, CachedFile> };

/**
 * Walks `dirs` recursively for .ttf/.otf/.ttc/.otc files (case-insensitive), parses each with
 * parseFont, and returns every face. Results are cached in `cacheFile` keyed by path with size and
 * mtimeMs, so a re-scan only parses new or changed files. Unreadable or invalid files are skipped.
 * Missing directories are fine.
 */
export async function scanLocalFonts(dirs: Paths["fontDirs"], cacheFile: string): Promise<LocalFace[]> {
  const previous = await readCache(cacheFile);
  const next: ScanCache = { version: 1, files: {} };
  let dirty = false;
  const faces: LocalFace[] = [];
  for (const dir of dirs) {
    for (const file of await listFontFiles(dir.path)) {
      // Nested or repeated scan roots must not list a file twice; the first root decides `system`.
      if (Object.hasOwn(next.files, file)) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const cached = Object.hasOwn(previous.files, file) ? previous.files[file] : undefined;
      let entry = cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached : null;
      if (!entry) {
        entry = await parseFile(file, stat.size, stat.mtimeMs);
        // Read failures are not cached: they depend on permissions, which can change without touching mtime.
        if (!entry) continue;
        dirty = true;
      }
      next.files[file] = entry;
      for (const face of entry.faces) faces.push({ path: file, system: dir.system, face });
    }
  }
  if (dirty || Object.keys(previous.files).some((file) => !Object.hasOwn(next.files, file))) {
    await writeCache(cacheFile, next);
  }
  return faces;
}

/** Sorted, so results do not depend on the filesystem's directory order. */
async function listFontFiles(dir: string): Promise<string[]> {
  // A missing, non-directory or unreadable root simply contributes no fonts.
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Dirent reports a symlink as a symlink, so linked directories are never entered and cannot loop.
    // Linked files are kept; stat in the caller follows them and drops anything that is not a file.
    if (entry.isDirectory()) files.push(...(await listFontFiles(full)));
    else if ((entry.isFile() || entry.isSymbolicLink()) && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

async function parseFile(file: string, size: number, mtimeMs: number): Promise<CachedFile | null> {
  if (size > MAX_FONT_BYTES) {
    return { size, mtimeMs, faces: [], error: `Larger than ${MAX_FONT_BYTES / 1024 / 1024} MB` };
  }
  const bytes = await fs.readFile(file).catch(() => null);
  if (!bytes) return null;
  try {
    return { size, mtimeMs, faces: parseFont(bytes).faces, error: null };
  } catch (error) {
    if (error instanceof FontParseError) return { size, mtimeMs, faces: [], error: error.message };
    throw error;
  }
}

async function readCache(file: string): Promise<ScanCache> {
  const empty: ScanCache = { version: 1, files: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const { version, files } = parsed as { version?: unknown; files?: unknown };
  if (version !== 1 || typeof files !== "object" || files === null) return empty;
  const valid: Record<string, CachedFile> = {};
  for (const [file, entry] of Object.entries(files)) {
    if (isCachedFile(entry)) valid[file] = entry;
  }
  return { version: 1, files: valid };
}

function isCachedFile(value: unknown): value is CachedFile {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Record<keyof CachedFile, unknown>>;
  return (
    typeof entry.size === "number" &&
    typeof entry.mtimeMs === "number" &&
    Array.isArray(entry.faces) &&
    (entry.error === null || typeof entry.error === "string")
  );
}

/** Temp file plus rename in the same directory, so a crash mid-write never leaves a torn cache. */
async function writeCache(file: string, cache: ScanCache): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(cache));
    await fs.rename(temp, file);
  } catch {
    // The cache only saves re-parsing; this scan's result is complete without it.
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
