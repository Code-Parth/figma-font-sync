import { rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../config/paths";
import { errorMessage } from "../helper";
import { type CliDeps, stopDeps } from "../main";
import { pidFilePath, stopHelper } from "./daemon";
import { CLI_NAME } from "./runtime";

export type UninstallOptions = {
  /** Also delete config, state, cache and the stored Google sign-in. */
  purge: boolean;
  /** Do not ask. Required when stdin is not a terminal. */
  yes: boolean;
};

/**
 * Stops the helper, turns off start at login and deletes the runtime copies and plugin files. Installed
 * fonts stay: designs use them, and the OS font folders are the user's. Exit 2 when it would have to ask
 * but cannot.
 */
export async function uninstall(options: UninstallOptions, deps: CliDeps): Promise<number> {
  const { out, paths } = deps;
  const autostart = deps.autostart();
  const targets = [path.join(paths.dataDir, "bin"), path.join(paths.dataDir, "figma-plugin")];
  if (options.purge) {
    targets.push(
      path.join(paths.configDir, "config.json"),
      // The secret store's fallback file; logout clears it too, this removes the file itself.
      path.join(paths.configDir, "credentials.json"),
      path.join(paths.stateDir, "installed.json"),
      pidFilePath(paths),
      path.join(paths.stateDir, "font-sync.log"),
      paths.cacheDir,
    );
    if (autostart.logFile) targets.push(autostart.logFile);
  }

  if (!options.yes) {
    if (!deps.interactive) {
      deps.err(`${CLI_NAME}: uninstall asks for confirmation; run it in a terminal or pass --yes.`);
      return 2;
    }
    out("This stops the Font Sync helper, turns off start at login and deletes:");
    for (const target of targets) out(`  ${target}`);
    if (options.purge) out("  the Google sign-in stored for Font Sync");
    out("Installed fonts stay.");
    const prompt = deps.prompt();
    try {
      if (!(await prompt.confirm("Uninstall Font Sync?", false))) {
        out("Nothing was changed.");
        return 1;
      }
    } finally {
      prompt.close();
    }
  }

  let failed = false;
  /** Keeps going after a failed step so one locked file does not leave everything else behind. */
  const step = async (task: () => Promise<void>) => {
    try {
      await task();
    } catch (err) {
      deps.err(`${CLI_NAME}: ${errorMessage(err)}`);
      failed = true;
    }
  };

  await step(async () => {
    // Before deleting anything: on Windows the running copy in <dataDir>/bin is locked.
    const { state } = await stopHelper(stopDeps(deps, autostart));
    out(state === "stopped" ? "Stopped the helper." : "The helper was not running.");
  });
  await step(async () => {
    await autostart.disable();
    out("Turned off start at login.");
  });
  if (options.purge) {
    // Through the helper, so the token is also revoked and removed from both secret stores. Creating the
    // helper recreates the config, state and cache folders, which are deleted below.
    await step(async () => {
      await (await deps.helper()).logout();
      out("Signed out of Google.");
    });
  }
  for (const target of targets) {
    await step(async () => {
      if (!(await exists(target))) return;
      await rm(target, { recursive: true, force: true });
      out(`Deleted ${target}`);
    });
  }
  // On macOS the data, config and state folders are one folder, which still holds config.json without --purge.
  const folders = options.purge ? [paths.dataDir, paths.configDir, paths.stateDir] : [paths.dataDir];
  for (const folder of new Set(folders)) {
    if (await removeIfEmpty(folder)) out(`Deleted ${folder}`);
  }

  out(`Installed fonts stay in ${paths.installDir}.`);
  out(`To remove the ${CLI_NAME} command too: ${removeCliCommand(deps.execPath, deps.standalone, deps.platform)}`);
  return failed ? 1 : 0;
}

/**
 * How to remove the program that is running: the package manager's command when it came from npm (the
 * binary then sits in node_modules), otherwise the file itself, as install.sh put it.
 */
export function removeCliCommand(execPath: string, standalone: boolean, platform: Platform): string {
  const parts = execPath.split(/[\\/]/);
  if (standalone && !parts.includes("node_modules")) {
    return platform === "win32" ? `del "${execPath}"` : `rm "${execPath}"`;
  }
  if (parts.includes(".pnpm")) return `pnpm rm -g ${CLI_NAME}`;
  if (standalone && parts.includes(".bun")) return `bun rm -g ${CLI_NAME}`;
  return `npm rm -g ${CLI_NAME}`;
}

async function removeIfEmpty(folder: string): Promise<boolean> {
  try {
    await rmdir(folder);
    return true;
  } catch {
    // Not empty or already gone; either way there is nothing to report.
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
