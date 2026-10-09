import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pidFilePath } from "../../src/cli/daemon";
import { removeCliCommand } from "../../src/cli/uninstall";
import { resolvePaths } from "../../src/config/paths";
import { main } from "../../src/main";
import { type Cli, makeCli } from "./cli-support";

const made: Cli[] = [];

afterEach(async () => {
  for (const each of made.splice(0)) await each.cleanup();
});

async function cli(opts: Parameters<typeof makeCli>[0] = {}): Promise<Cli> {
  const created = await makeCli(opts);
  made.push(created);
  return created;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function touch(file: string, text = "x"): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

/** What a machine looks like after setup and some use, with the helper running under launchd. */
async function installed(each: Cli) {
  const { paths } = each;
  expect(await main(["plugin"], each.deps)).toBe(0);
  each.out.length = 0;
  const files = {
    runtime: await touch(path.join(paths.dataDir, "bin", "figma-font-sync-0.1.0")),
    plugin: path.join(paths.dataDir, "figma-plugin"),
    config: await touch(path.join(paths.configDir, "config.json"), "{}"),
    credentials: await touch(path.join(paths.configDir, "credentials.json"), "{}"),
    installed: await touch(path.join(paths.stateDir, "installed.json"), "{}"),
    pid: await touch(pidFilePath(paths), "{}"),
    log: await touch(path.join(paths.stateDir, "font-sync.log")),
    cache: await touch(path.join(paths.cacheDir, "library-faces.json"), "{}"),
    serviceLog: await touch(path.join(each.home, "Library", "Logs", "font-sync.log")),
    font: await touch(path.join(paths.installDir, "a1b2c3d4-Inter.ttf")),
  };
  each.service.registered = true;
  each.helperProcess.running = true;
  return files;
}

describe("uninstall", () => {
  it("stops the helper, turns off start at login and deletes the runtime and plugin files only", async () => {
    const each = await cli();
    const files = await installed(each);
    expect(await main(["uninstall", "--yes"], each.deps)).toBe(0);

    expect(each.calls.serviceStops).toBe(1);
    expect(each.calls.disabled).toBe(1);
    expect(each.helperProcess.running).toBe(false);
    expect(await exists(path.dirname(files.runtime))).toBe(false);
    expect(await exists(files.plugin)).toBe(false);
    for (const kept of [files.config, files.credentials, files.installed, files.cache, files.serviceLog, files.font]) {
      expect(await exists(kept)).toBe(true);
    }
    expect(each.calls.logouts).toBe(0);
    expect(each.out).toEqual([
      "Stopped the helper.",
      "Turned off start at login.",
      `Deleted ${path.join(each.paths.dataDir, "bin")}`,
      `Deleted ${files.plugin}`,
      `Installed fonts stay in ${each.paths.installDir}.`,
      "To remove the figma-font-sync command too: npm rm -g figma-font-sync",
    ]);
  });

  it("with --purge also deletes config, state, cache and the Google sign-in, but not fonts", async () => {
    const each = await cli();
    const files = await installed(each);
    expect(await main(["uninstall", "--purge", "--yes"], each.deps)).toBe(0);

    expect(each.calls.logouts).toBe(1);
    for (const gone of [
      files.runtime,
      files.plugin,
      files.config,
      files.credentials,
      files.installed,
      files.pid,
      files.log,
      each.paths.cacheDir,
      files.serviceLog,
    ]) {
      expect(await exists(gone)).toBe(false);
    }
    // macOS keeps data, config and state in one folder, which is empty now.
    expect(await exists(each.paths.configDir)).toBe(false);
    expect(await exists(files.font)).toBe(true);
    expect(each.out).toContain("Signed out of Google.");
    expect(each.out).toContain(`Deleted ${each.paths.configDir}`);
  });

  it("removes the whole data folder where it is separate, as on Linux", async () => {
    const each = await cli();
    each.deps.platform = "linux";
    each.deps.paths = resolvePaths("linux", {}, each.home);
    const { paths } = each.deps;
    await touch(path.join(paths.dataDir, "bin", "figma-font-sync-0.1.0"));
    await touch(path.join(paths.dataDir, "figma-plugin", "manifest.json"), "{}");
    const config = await touch(path.join(paths.configDir, "config.json"), "{}");
    expect(await main(["uninstall", "--yes"], each.deps)).toBe(0);
    expect(await exists(paths.dataDir)).toBe(false);
    expect(await exists(config)).toBe(true);
  });

  it("refuses to run without a terminal unless --yes is given", async () => {
    const each = await cli();
    const files = await installed(each);
    expect(await main(["uninstall"], each.deps)).toBe(2);
    expect(each.err).toEqual(["figma-font-sync: uninstall asks for confirmation; run it in a terminal or pass --yes."]);
    expect(each.calls.serviceStops).toBe(0);
    expect(await exists(files.runtime)).toBe(true);
  });

  it("asks first in a terminal, defaulting to no", async () => {
    const declined = await cli({ interactive: true, answers: [""] });
    const files = await installed(declined);
    expect(await main(["uninstall", "--purge"], declined.deps)).toBe(1);
    expect(declined.prompt.asked).toEqual(["Uninstall Font Sync?"]);
    expect(declined.prompt.closed).toBe(true);
    expect(declined.out).toContain(`  ${files.config}`);
    expect(declined.out).toContain("Installed fonts stay.");
    expect(declined.out.at(-1)).toBe("Nothing was changed.");
    expect(await exists(files.runtime)).toBe(true);
    expect(declined.calls.disabled).toBe(0);

    const accepted = await cli({ interactive: true, answers: ["y"] });
    const acceptedFiles = await installed(accepted);
    expect(await main(["uninstall"], accepted.deps)).toBe(0);
    expect(await exists(acceptedFiles.runtime)).toBe(false);
  });

  it("keeps going when a step fails and exits 1", async () => {
    const each = await cli({
      autostart: {
        stopService: async () => {
          throw new Error("launchctl bootout failed: 5");
        },
      },
    });
    const files = await installed(each);
    expect(await main(["uninstall", "--yes"], each.deps)).toBe(1);
    expect(each.err).toEqual(["figma-font-sync: launchctl bootout failed: 5"]);
    expect(each.calls.disabled).toBe(1);
    expect(await exists(files.runtime)).toBe(false);
  });
});

describe("removeCliCommand", () => {
  it("names the file install.sh put on PATH", () => {
    expect(removeCliCommand("/Users/ada/.local/bin/figma-font-sync", true, "darwin")).toBe(
      'rm "/Users/ada/.local/bin/figma-font-sync"',
    );
    expect(removeCliCommand("C:\\Tools\\figma-font-sync.exe", true, "win32")).toBe('del "C:\\Tools\\figma-font-sync.exe"');
  });

  it("names the package manager for a binary inside node_modules", () => {
    const npm = "/usr/local/lib/node_modules/figma-font-sync/node_modules/@figma-font-sync/darwin-arm64/bin/figma-font-sync";
    expect(removeCliCommand(npm, true, "darwin")).toBe("npm rm -g figma-font-sync");
    const pnpm =
      "/Users/ada/Library/pnpm/global/5/.pnpm/@figma-font-sync+darwin-arm64@0.1.0/node_modules/@figma-font-sync/darwin-arm64/bin/figma-font-sync";
    expect(removeCliCommand(pnpm, true, "darwin")).toBe("pnpm rm -g figma-font-sync");
    const bun = "/Users/ada/.bun/install/global/node_modules/@figma-font-sync/darwin-arm64/bin/figma-font-sync";
    expect(removeCliCommand(bun, true, "darwin")).toBe("bun rm -g figma-font-sync");
    const windows = "C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\figma-font-sync\\node_modules\\@figma-font-sync\\windows-x64\\bin\\figma-font-sync.exe";
    expect(removeCliCommand(windows, true, "win32")).toBe("npm rm -g figma-font-sync");
  });

  it("never offers to delete bun when running from source", () => {
    expect(removeCliCommand("/Users/ada/.bun/bin/bun", false, "darwin")).toBe("npm rm -g figma-font-sync");
  });
});
