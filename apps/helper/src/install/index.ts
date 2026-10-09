import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Paths, Platform } from "../config/paths";
import { HelperError } from "../errors";
import type { Face, FontFormat } from "../fonts/types";
import { linuxRegistration } from "./linux";
import { type CommandRunner, runCommand } from "./run";
import { windowsRegistration } from "./windows";

export type InstallInput = {
  bytes: Uint8Array;
  /** Drive md5Checksum, already verified against `bytes`. */
  md5: string;
  format: FontFormat;
  faces: Face[];
  /** Library file name; never used as a path. */
  sourceName: string;
};

export type InstalledFont = { paths: string[]; registryValues: string[] };

export interface Installer {
  /** Writes a new file (never overwrites) and registers it with the OS for the current user. */
  install(input: InstallInput): Promise<InstalledFont>;
  /** Unregisters and deletes. Returns paths that could not be deleted yet. */
  uninstall(installed: InstalledFont): Promise<{ pendingDeletes: string[] }>;
  /** Retries earlier failed deletes; returns the ones still pending. */
  retryPendingDeletes(paths: string[]): Promise<string[]>;
}

const MAX_FILE_NAME = 120;
const FONT_EXTENSION = /\.(ttf|otf|ttc|otc)$/i;

/**
 * `<PostScript name of the first face, or a sanitized source base name>-<md5 first 8>.<ext>`,
 * restricted to [A-Za-z0-9._-] and at most 120 characters. Never derived from unsanitized input.
 */
export function installFileName(input: Pick<InstallInput, "md5" | "format" | "faces" | "sourceName">): string {
  const hash = input.md5.toLowerCase().slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(hash)) throw new Error("installFileName needs an md5 hex digest");
  const suffix = `-${hash}.${input.format}`;
  const room = MAX_FILE_NAME - suffix.length;
  const base =
    safeBase(input.faces[0]?.postscript ?? "", room) ||
    safeBase(input.sourceName.replace(FONT_EXTENSION, ""), room) ||
    "font";
  return base + suffix;
}

function safeBase(name: string, maxLength: number): string {
  const trim = (value: string) => value.replace(/^[_-]+|[_-]+$/g, "");
  // Dots go too, so the extension's is the only one: no "..", no hidden files, no Windows device names like "NUL.x".
  const ascii = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_");
  return trim(trim(ascii).slice(0, maxLength));
}

/** How one OS makes a file in installDir usable, beyond the file being there. */
export type Registration = {
  /** Runs once the file is in place. Returns the registry value names it wrote. */
  register(file: string, input: InstallInput): Promise<string[]>;
  /** Runs before the files are deleted. */
  unregister(installed: InstalledFont): Promise<void>;
  /** Runs after at least one file was deleted. */
  deleted(): Promise<void>;
};

export type InstallerDeps = { run: CommandRunner };

export function createInstaller(platform: Platform, paths: Paths): Installer {
  return createInstallerWith(platform, paths, { run: runCommand });
}

/** `createInstaller` with the command runner injected. Files go to `paths.installDir`. */
export function createInstallerWith(platform: Platform, paths: Paths, deps: InstallerDeps): Installer {
  const registration = registrationFor(platform, paths, deps);
  return {
    async install(input) {
      await fs.mkdir(paths.installDir, { recursive: true });
      const file = path.join(paths.installDir, installFileName(input));
      const created = await writeNew(file, input.bytes, input.md5);
      try {
        return { paths: [file], registryValues: await registration.register(file, input) };
      } catch (error) {
        // An unregistered file is not locked, and the local scan of installDir would report it as installed.
        if (created) await fs.rm(file, { force: true });
        throw error;
      }
    },

    async uninstall(installed) {
      await registration.unregister(installed);
      const pendingDeletes: string[] = [];
      for (const file of installed.paths) {
        if (!(await remove(file))) pendingDeletes.push(file);
      }
      if (pendingDeletes.length < installed.paths.length) await registration.deleted();
      return { pendingDeletes };
    },

    async retryPendingDeletes(files) {
      const pending: string[] = [];
      for (const file of files) {
        // Anything unexpected stays pending: this runs at startup and must not stop the helper.
        if (!(await remove(file).catch(() => false))) pending.push(file);
      }
      if (pending.length < files.length) await registration.deleted();
      return pending;
    },
  };
}

function registrationFor(platform: Platform, paths: Paths, deps: InstallerDeps): Registration {
  switch (platform) {
    case "darwin":
      // fontd watches ~/Library/Fonts, so the file alone is the install.
      return { register: async () => [], unregister: async () => {}, deleted: async () => {} };
    case "linux":
      return linuxRegistration(paths.installDir, deps.run);
    case "win32":
      return windowsRegistration(deps.run);
  }
}

/**
 * Creates `file` with O_EXCL. An existing file with the same bytes is reused, and one left by an interrupted
 * write is replaced. Returns whether this call created it.
 */
async function writeNew(file: string, bytes: Uint8Array, md5: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(file, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(file);
    if (existing.equals(bytes)) return false;
    // The name carries the md5 prefix, so only a partial write leaves content that hashes to another prefix.
    if (createHash("md5").update(existing).digest("hex").startsWith(md5.toLowerCase().slice(0, 8))) {
      throw new HelperError("install-failed", `A different font file named ${path.basename(file)} is already installed`);
    }
    await fs.rm(file, { force: true });
    handle = await fs.open(file, "wx");
  }
  try {
    try {
      await handle.writeFile(bytes);
      // installed.json must not record a file whose data a power loss could still drop.
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.rm(file, { force: true });
    throw error;
  }
  return true;
}

const LOCKED = new Set(["EBUSY", "EPERM", "EACCES"]);

/** True when the file is gone (a missing file counts), false when the OS holds it, e.g. a loaded font on Windows. */
async function remove(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code !== undefined && LOCKED.has(code)) return false;
    throw error;
  }
}
