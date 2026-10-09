import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import fs, { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Paths, Platform } from "../../src/config/paths";
import { HelperError } from "../../src/errors";
import { createInstallerWith, type InstallInput } from "../../src/install";
import type { CommandRunner } from "../../src/install/run";
import { INSTALL_SCRIPT, POWERSHELL, registryValueName, UNINSTALL_SCRIPT } from "../../src/install/windows";
import { face, fakeRunner, ok } from "./support";

const MD5 = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

let root: string;
let installDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "font-sync-install-"));
  installDir = path.join(root, "fonts");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function pathsFor(dir: string): Paths {
  return { configDir: root, cacheDir: root, stateDir: root, dataDir: root, installDir: dir, fontDirs: [] };
}

function input(overrides: Partial<InstallInput> = {}): InstallInput {
  return {
    bytes: new Uint8Array([0, 1, 0, 0, 7, 7, 7]),
    md5: MD5,
    format: "ttf",
    faces: [face()],
    sourceName: "Inter-Bold.ttf",
    ...overrides,
  };
}

function installer(platform: Platform, run: CommandRunner = fakeRunner().run) {
  return createInstallerWith(platform, pathsFor(installDir), { run });
}

const windowsOk = () => ok("font-sync-ok\r\n");

describe.each(["darwin", "linux", "win32"] as const)("%s installer files", (platform) => {
  const run = () => (platform === "win32" ? fakeRunner(windowsOk).run : fakeRunner().run);

  it("writes the file once into installDir", async () => {
    const result = await installer(platform, run()).install(input());
    const file = path.join(installDir, "Inter-Bold-a1b2c3d4.ttf");
    expect(result.paths).toEqual([file]);
    expect([...(await readFile(file))]).toEqual([...input().bytes]);
    expect(await readdir(installDir)).toEqual(["Inter-Bold-a1b2c3d4.ttf"]);
  });

  it("flushes the file to disk before reporting it installed", async () => {
    const synced: string[] = [];
    const realOpen = fs.open;
    const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        synced.push(String(file));
        await sync();
      };
      return handle;
    });
    try {
      const result = await installer(platform, run()).install(input());
      expect(synced).toEqual(result.paths);
    } finally {
      open.mockRestore();
    }
  });

  it("reuses an existing file with identical bytes", async () => {
    const subject = installer(platform, run());
    const first = await subject.install(input());
    const second = await subject.install(input());
    expect(second.paths).toEqual(first.paths);
    expect(await readdir(installDir)).toEqual(["Inter-Bold-a1b2c3d4.ttf"]);
  });

  it("never overwrites a different file with the same name", async () => {
    // An intact file whose md5 shares the 8-digit prefix in the name: a real collision.
    const other = "someone else's file";
    const md5 = createHash("md5").update(other).digest("hex");
    await fs.mkdir(installDir, { recursive: true });
    const file = path.join(installDir, `Inter-Bold-${md5.slice(0, 8)}.ttf`);
    await writeFile(file, other);
    const error = await installer(platform, run())
      .install(input({ md5 }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect((error as HelperError).code).toBe("install-failed");
    expect(await readFile(file, "utf8")).toBe(other);
  });

  it("replaces a partial file left by an interrupted write", async () => {
    await fs.mkdir(installDir, { recursive: true });
    const file = path.join(installDir, "Inter-Bold-a1b2c3d4.ttf");
    await writeFile(file, input().bytes.slice(0, 3));
    const result = await installer(platform, run()).install(input());
    expect(result.paths).toEqual([file]);
    expect([...(await readFile(file))]).toEqual([...input().bytes]);
    expect(await readdir(installDir)).toEqual(["Inter-Bold-a1b2c3d4.ttf"]);
  });

  it("deletes on uninstall and treats a missing file as deleted", async () => {
    const subject = installer(platform, run());
    const installed = await subject.install(input());
    expect(await subject.uninstall(installed)).toEqual({ pendingDeletes: [] });
    expect(await readdir(installDir)).toEqual([]);
    expect(await subject.uninstall(installed)).toEqual({ pendingDeletes: [] });
  });

  it("keeps locked files pending and retries them later", async () => {
    const subject = installer(platform, run());
    const installed = await subject.install(input());
    const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(busy);
    try {
      expect(await subject.uninstall(installed)).toEqual({ pendingDeletes: installed.paths });
    } finally {
      unlink.mockRestore();
    }
    expect(await readdir(installDir)).toEqual(["Inter-Bold-a1b2c3d4.ttf"]);

    const gone = path.join(installDir, "already-gone.ttf");
    expect(await subject.retryPendingDeletes([...installed.paths, gone])).toEqual([]);
    expect(await readdir(installDir)).toEqual([]);
  });

  it("returns still-locked files from retryPendingDeletes", async () => {
    const subject = installer(platform, run());
    const installed = await subject.install(input());
    const denied = Object.assign(new Error("denied"), { code: "EPERM" });
    const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(denied);
    try {
      expect(await subject.retryPendingDeletes(installed.paths)).toEqual(installed.paths);
    } finally {
      unlink.mockRestore();
    }
  });
});

describe("darwin installer", () => {
  it("runs no commands", async () => {
    const runner = fakeRunner();
    const subject = installer("darwin", runner.run);
    const installed = await subject.install(input());
    expect(installed.registryValues).toEqual([]);
    await subject.uninstall(installed);
    expect(runner.calls).toEqual([]);
  });
});

describe("linux installer", () => {
  it("creates installDir and refreshes fontconfig for it", async () => {
    const runner = fakeRunner();
    const subject = installer("linux", runner.run);
    const installed = await subject.install(input());
    expect(installed.registryValues).toEqual([]);
    await subject.uninstall(installed);
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["fc-cache", "-f", installDir],
      ["fc-cache", "-f", installDir],
    ]);
  });

  it("tolerates a failing fc-cache", async () => {
    const runner = fakeRunner(() => ({ code: 1, stdout: "", stderr: "broken" }));
    const installed = await installer("linux", runner.run).install(input());
    expect(installed.paths).toHaveLength(1);
  });

  it("tolerates a missing fc-cache", async () => {
    const runner = fakeRunner(() => {
      throw Object.assign(new Error("spawn fc-cache ENOENT"), { code: "ENOENT" });
    });
    const subject = installer("linux", runner.run);
    const installed = await subject.install(input());
    expect(await subject.uninstall(installed)).toEqual({ pendingDeletes: [] });
  });
});

describe("win32 installer", () => {
  const evil = face({
    fullName: "Evil'; Remove-Item -Recurse C:\\ ; '",
    postscript: "Evil-Regular",
  });

  it("passes the path and registry name only through the environment", async () => {
    const runner = fakeRunner(windowsOk);
    const installed = await installer("win32", runner.run).install(input({ faces: [evil] }));
    const file = path.join(installDir, "Evil-Regular-a1b2c3d4.ttf");
    const name = "Evil'; Remove-Item -Recurse C:\\ ; ' (TrueType) #a1b2c3d4";

    expect(installed).toEqual({ paths: [file], registryValues: [name] });
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.argv).toEqual(POWERSHELL);
    expect(call.argv).toEqual([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "-",
    ]);
    expect(call.env).toEqual({ FS_FONT_PATH: file, FS_REG_NAME: name });
    expect(call.stdin).toBe(INSTALL_SCRIPT);
    for (const text of [file, name, "Evil", installDir, "a1b2c3d4"]) {
      expect(call.stdin).not.toContain(text);
      expect(call.argv.join(" ")).not.toContain(text);
    }
  });

  it("writes the registry value, then loads the font and broadcasts WM_FONTCHANGE", () => {
    expect(INSTALL_SCRIPT).toContain("$env:FS_FONT_PATH");
    expect(INSTALL_SCRIPT).toContain("$env:FS_REG_NAME");
    expect(INSTALL_SCRIPT).toContain(String.raw`'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'`);
    expect(INSTALL_SCRIPT).toContain("-Name $name -PropertyType String -Value $path -Force");
    expect(INSTALL_SCRIPT).toContain("AddFontResourceW($path)");
    // HWND_BROADCAST, WM_FONTCHANGE, SMTO_ABORTIFHUNG, 1000 ms.
    expect(INSTALL_SCRIPT).toContain("SendMessageTimeoutW([IntPtr]0xFFFF, 0x1D, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000,");
    expect(INSTALL_SCRIPT.indexOf("New-ItemProperty")).toBeLessThan(INSTALL_SCRIPT.indexOf("Add-Type"));
    // The marker is built at runtime so an echoed script can never look like success.
    expect(INSTALL_SCRIPT).not.toContain("font-sync-ok");
    expect(INSTALL_SCRIPT).toEndWith("}\n\n");
    expect(INSTALL_SCRIPT).not.toContain("\u2014");
  });

  it("unloads in a loop, removes the value and broadcasts before deleting", () => {
    expect(UNINSTALL_SCRIPT).toContain("RemoveFontResourceW($path)");
    expect(UNINSTALL_SCRIPT).toMatch(/for \(.*RemoveFontResourceW\(\$path\); \$i\+\+\)/);
    expect(UNINSTALL_SCRIPT).toContain("Remove-ItemProperty -LiteralPath $key -Name $name");
    const order = ["RemoveFontResourceW($path)", "Remove-ItemProperty", "SendMessageTimeoutW([IntPtr]"];
    const positions = order.map((text) => UNINSTALL_SCRIPT.indexOf(text));
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(UNINSTALL_SCRIPT).not.toContain("font-sync-ok");
  });

  it("succeeds when Add-Type is blocked, as long as the registry value was written", async () => {
    // The script prints the marker before Add-Type; a blocked Add-Type is caught and the exit code may be 1.
    const runner = fakeRunner(() => ({ code: 1, stdout: "font-sync-ok\r\n", stderr: "Cannot add type" }));
    const installed = await installer("win32", runner.run).install(input());
    expect(installed.registryValues).toHaveLength(1);
  });

  it("fails and removes the new file when the registry write fails", async () => {
    const runner = fakeRunner(() => ({ code: 1, stdout: "font-sync-error: Access denied\r\n", stderr: "" }));
    const error = await installer("win32", runner.run)
      .install(input())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect((error as HelperError).message).toContain("Access denied");
    expect(await readdir(installDir)).toEqual([]);
  });

  it("fails cleanly when PowerShell cannot start", async () => {
    const runner = fakeRunner(() => {
      throw new Error("spawn powershell.exe ENOENT");
    });
    const error = await installer("win32", runner.run)
      .install(input())
      .catch((e: unknown) => e);
    expect((error as HelperError).code).toBe("install-failed");
    expect(await readdir(installDir)).toEqual([]);
  });

  it("keeps a reused file when registration fails", async () => {
    await installer("win32", fakeRunner(windowsOk).run).install(input());
    const failing = fakeRunner(() => ({ code: 1, stdout: "", stderr: "nope" }));
    await expect(installer("win32", failing.run).install(input())).rejects.toThrow("nope");
    expect(await readdir(installDir)).toEqual(["Inter-Bold-a1b2c3d4.ttf"]);
  });

  it("unregisters each path with its value through the environment, then deletes", async () => {
    const runner = fakeRunner(windowsOk);
    const subject = installer("win32", runner.run);
    const installed = await subject.install(input());
    runner.calls.length = 0;

    expect(await subject.uninstall(installed)).toEqual({ pendingDeletes: [] });
    expect(runner.calls).toEqual([
      {
        argv: POWERSHELL,
        env: { FS_FONT_PATH: installed.paths[0]!, FS_REG_NAME: installed.registryValues[0]! },
        stdin: UNINSTALL_SCRIPT,
      },
    ]);
    expect(await readdir(installDir)).toEqual([]);
  });

  it("keeps the file when unregistering fails", async () => {
    const subject = installer("win32", fakeRunner(windowsOk).run);
    const installed = await subject.install(input());
    const failing = fakeRunner(() => ok("font-sync-error: the registry value could not be removed\r\n"));
    await expect(installer("win32", failing.run).uninstall(installed)).rejects.toThrow("could not be removed");
    expect(await readdir(installDir)).toEqual(["Inter-Bold-a1b2c3d4.ttf"]);
  });

  it("returns a locked file as pending after unregistering it", async () => {
    const subject = installer("win32", fakeRunner(windowsOk).run);
    const installed = await subject.install(input());
    const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
    const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(busy);
    try {
      expect(await subject.uninstall(installed)).toEqual({ pendingDeletes: installed.paths });
    } finally {
      unlink.mockRestore();
    }
  });
});

describe("registryValueName", () => {
  it("uses the full name and the TrueType or OpenType suffix", () => {
    expect(registryValueName({ faces: [face()], format: "ttf", md5: MD5, sourceName: "x" })).toBe(
      "Inter Bold (TrueType) #a1b2c3d4",
    );
    expect(registryValueName({ faces: [face()], format: "otf", md5: MD5, sourceName: "x" })).toBe(
      "Inter Bold (OpenType) #a1b2c3d4",
    );
  });

  it("falls back to family and style", () => {
    const faces = [face({ fullName: null, family: "Brand", style: "Light Italic" })];
    expect(registryValueName({ faces, format: "ttf", md5: MD5, sourceName: "x" })).toBe(
      "Brand Light Italic (TrueType) #a1b2c3d4",
    );
  });

  it("joins distinct collection names with &", () => {
    const faces = [
      face({ fullName: "Cambria" }),
      face({ fullName: "Cambria Math" }),
      face({ fullName: "Cambria" }),
    ];
    expect(registryValueName({ faces, format: "ttc", md5: MD5, sourceName: "x" })).toBe(
      "Cambria & Cambria Math (TrueType) #a1b2c3d4",
    );
  });

  it("uses the source name when there are no faces", () => {
    expect(registryValueName({ faces: [], format: "ttf", md5: MD5, sourceName: "Brand.ttf" })).toBe(
      "Brand.ttf (TrueType) #a1b2c3d4",
    );
  });

  it("replaces control characters and wildcard syntax", () => {
    const faces = [face({ fullName: "Bad\u0000Name [v*?]`\n" })];
    expect(registryValueName({ faces, format: "ttf", md5: MD5, sourceName: "x" })).toBe(
      "Bad_Name _v_____ (TrueType) #a1b2c3d4",
    );
  });
});
