import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Paths, Platform } from "../config/paths";

export const CLI_NAME = "figma-font-sync";

/** What the background helper and start-at-login launch. */
export type Runtime = {
  /** argv that runs `serve`: the versioned copy in `<dataDir>/bin`, or `[bun, main, "serve"]` from source. */
  serveCommand: string[];
  /** True for `bun src/main.ts`: nothing is copied and serveCommand points into the repo. */
  fromSource: boolean;
};

export type RuntimeInput = {
  platform: Platform;
  paths: Paths;
  version: string;
  /** process.execPath */
  execPath: string;
  /** Bun.main */
  main: string;
  /** Bun.isStandaloneExecutable */
  standalone: boolean;
};

/** `figma-font-sync-<version>[-background][.exe]`, the file name of a runtime copy. */
export function runtimeFileName(platform: Platform, version: string, background: boolean): string {
  return `${CLI_NAME}-${version}${background ? "-background" : ""}${platform === "win32" ? ".exe" : ""}`;
}

/**
 * Copies the running standalone binary into `<dataDir>/bin/` under its versioned name, unless a copy with
 * the same size and contents is already there. On Windows also copies the console-less
 * `figma-font-sync-background.exe` (or `figma-font-sync-<os>-<arch>-background.exe`) found next to
 * execPath, and serveCommand runs that one; a missing background exe is an error. Then deletes older
 * versioned copies, ignoring the ones the OS keeps locked. From source, copies nothing.
 */
export async function installRuntime(input: RuntimeInput): Promise<Runtime> {
  const { platform, version, execPath } = input;
  if (!input.standalone) return { serveCommand: [execPath, input.main, "serve"], fromSource: true };

  const binDir = path.join(input.paths.dataDir, "bin");
  await mkdir(binDir, { recursive: true });
  const cli = path.join(binDir, runtimeFileName(platform, version, false));
  await copyIfDifferent(execPath, cli);
  let serve = cli;
  if (platform === "win32") {
    // A console program started at login or by `start` opens a window, so the background exe serves.
    serve = path.join(binDir, runtimeFileName(platform, version, true));
    await copyIfDifferent(await findBackgroundExe(execPath), serve);
  }
  await pruneOldCopies(binDir, [path.basename(cli), path.basename(serve)]);
  return { serveCommand: [serve, "serve"], fromSource: false };
}

/**
 * The npm package ships `figma-font-sync-background.exe` beside `figma-font-sync.exe`; a release download
 * pairs `figma-font-sync-windows-x64.exe` with `figma-font-sync-windows-x64-background.exe`.
 */
async function findBackgroundExe(execPath: string): Promise<string> {
  // win32 parsing accepts both separators, so this also works on the POSIX temp dirs tests use.
  const dir = path.win32.dirname(execPath);
  const stem = path.win32.basename(execPath).replace(/\.exe$/i, "");
  const candidates = [...new Set([`${CLI_NAME}-background.exe`, `${stem}-background.exe`])];
  for (const name of candidates) {
    const file = path.join(dir, name);
    if (await isFile(file)) return file;
  }
  throw new Error(
    `${candidates.join(" or ")} is missing next to ${execPath}. Reinstall with "npm i -g ${CLI_NAME}" to get it back.`,
  );
}

/** Never writes over the target in place: a running copy would crash on macOS, and Windows refuses anyway. */
async function copyIfDifferent(source: string, target: string): Promise<void> {
  if (path.resolve(source) === path.resolve(target) || (await sameContents(source, target))) return;
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await copyFile(source, temp);
    await chmod(temp, 0o755);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    if (isLocked(error)) {
      throw new Error(
        `${target} is in use and differs from ${source}. Stop the helper ("${CLI_NAME} stop") and try again.`,
      );
    }
    throw error;
  }
}

const CHUNK_BYTES = 1 << 20;

/** Size first, then bytes in chunks: the binaries are tens of megabytes. False when either is missing. */
async function sameContents(a: string, b: string): Promise<boolean> {
  const [statA, statB] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  if (!statA?.isFile() || !statB?.isFile() || statA.size !== statB.size) return false;
  const [handleA, handleB] = await Promise.all([open(a, "r"), open(b, "r")]);
  try {
    const bufferA = Buffer.alloc(CHUNK_BYTES);
    const bufferB = Buffer.alloc(CHUNK_BYTES);
    for (let offset = 0; offset < statA.size; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, statA.size - offset);
      const [readA, readB] = await Promise.all([
        handleA.read(bufferA, 0, length, offset),
        handleB.read(bufferB, 0, length, offset),
      ]);
      if (readA.bytesRead !== length || readB.bytesRead !== length) return false;
      if (!bufferA.subarray(0, length).equals(bufferB.subarray(0, length))) return false;
    }
    return true;
  } finally {
    await Promise.all([handleA.close(), handleB.close()]);
  }
}

/** Deletes every other `figma-font-sync-*` file in binDir. A copy that is still running stays until next time. */
async function pruneOldCopies(binDir: string, keep: string[]): Promise<void> {
  for (const name of await readdir(binDir)) {
    if (!name.startsWith(`${CLI_NAME}-`) || keep.includes(name)) continue;
    try {
      await rm(path.join(binDir, name), { force: true });
    } catch (error) {
      if (!isLocked(error)) throw error;
    }
  }
}

function isLocked(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}
