import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installRuntime, type RuntimeInput, runtimeFileName } from "../../src/cli/runtime";
import { type Paths, type Platform, resolvePaths } from "../../src/config/paths";

let root: string;
let paths: Paths;
let binDir: string;
/** Where npm (or a release download) put the binary the user ran. */
let installed: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "font-sync-runtime-"));
  // Only dataDir is used; the rest stay inside the temp dir too.
  paths = { ...resolvePaths("linux", {}, path.join(root, "home")), dataDir: path.join(root, "data") };
  binDir = path.join(paths.dataDir, "bin");
  installed = path.join(root, "node_modules", "@figma-font-sync", "pkg", "bin");
  await mkdir(installed, { recursive: true });
});

afterEach(async () => {
  await chmod(binDir, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

function input(platform: Platform, execPath: string, overrides: Partial<RuntimeInput> = {}): RuntimeInput {
  return { platform, paths, version: "1.2.0", execPath, main: "/$bunfs/root/figma-font-sync", standalone: true, ...overrides };
}

async function binary(name: string, contents: string): Promise<string> {
  const file = path.join(installed, name);
  await writeFile(file, contents);
  return file;
}

describe("runtimeFileName", () => {
  it("names versioned copies, with .exe and the background variant on Windows", () => {
    expect(runtimeFileName("darwin", "1.2.0", false)).toBe("figma-font-sync-1.2.0");
    expect(runtimeFileName("linux", "1.2.0-beta.1", false)).toBe("figma-font-sync-1.2.0-beta.1");
    expect(runtimeFileName("win32", "1.2.0", false)).toBe("figma-font-sync-1.2.0.exe");
    expect(runtimeFileName("win32", "1.2.0", true)).toBe("figma-font-sync-1.2.0-background.exe");
  });
});

describe("installRuntime", () => {
  it("copies nothing from source and serves through bun and the script", async () => {
    const runtime = await installRuntime(
      input("darwin", "/opt/bun/bin/bun", { standalone: false, main: "/repo/apps/helper/src/main.ts" }),
    );
    expect(runtime).toEqual({ serveCommand: ["/opt/bun/bin/bun", "/repo/apps/helper/src/main.ts", "serve"], fromSource: true });
    expect(await stat(binDir).catch(() => null)).toBeNull();
  });

  it("copies the running binary under its versioned name and serves from the copy", async () => {
    const exec = await binary("figma-font-sync", "binary v1.2.0");
    const runtime = await installRuntime(input("darwin", exec));
    const copy = path.join(binDir, "figma-font-sync-1.2.0");
    expect(runtime).toEqual({ serveCommand: [copy, "serve"], fromSource: false });
    expect(await readFile(copy, "utf8")).toBe("binary v1.2.0");
    if (process.platform !== "win32") expect((await stat(copy)).mode & 0o777).toBe(0o755);
    // A finished copy leaves no temp file behind.
    expect(await readdir(binDir)).toEqual(["figma-font-sync-1.2.0"]);
  });

  it("leaves an identical copy alone and replaces one that differs, even at the same size", async () => {
    const exec = await binary("figma-font-sync", "binary v1.2.0");
    await installRuntime(input("darwin", exec));
    const copy = path.join(binDir, "figma-font-sync-1.2.0");
    const first = await stat(copy);

    await installRuntime(input("darwin", exec));
    expect((await stat(copy)).ino).toBe(first.ino);

    await writeFile(copy, "binary v1.2.X");
    await installRuntime(input("darwin", exec));
    expect(await readFile(copy, "utf8")).toBe("binary v1.2.0");
    // Replaced through a rename, never written in place: a running copy keeps its own file.
    expect((await stat(copy)).ino).not.toBe(first.ino);
  });

  it("deletes older versions and nothing else", async () => {
    await mkdir(binDir, { recursive: true });
    for (const name of ["figma-font-sync-1.1.0", "figma-font-sync-1.1.0-background.exe", "figma-font-sync-1.3.0", "notes.txt"]) {
      await writeFile(path.join(binDir, name), "old");
    }
    const exec = await binary("figma-font-sync", "binary v1.2.0");
    await installRuntime(input("linux", exec));
    expect((await readdir(binDir)).sort()).toEqual(["figma-font-sync-1.2.0", "notes.txt"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps an older copy it may not delete",
    async () => {
      const exec = await binary("figma-font-sync", "binary v1.2.0");
      await installRuntime(input("darwin", exec));
      await writeFile(path.join(binDir, "figma-font-sync-1.1.0"), "old");
      // A read-only directory refuses the unlink with EACCES, the way Windows refuses a running .exe.
      await chmod(binDir, 0o555);
      const runtime = await installRuntime(input("darwin", exec));
      expect(runtime.serveCommand).toEqual([path.join(binDir, "figma-font-sync-1.2.0"), "serve"]);
      expect((await readdir(binDir)).sort()).toEqual(["figma-font-sync-1.1.0", "figma-font-sync-1.2.0"]);
    },
  );

  it("on Windows copies the npm package's background exe too and serves with it", async () => {
    const exec = await binary("figma-font-sync.exe", "console exe");
    await binary("figma-font-sync-background.exe", "background exe");
    const runtime = await installRuntime(input("win32", exec));
    const background = path.join(binDir, "figma-font-sync-1.2.0-background.exe");
    expect(runtime).toEqual({ serveCommand: [background, "serve"], fromSource: false });
    expect(await readFile(path.join(binDir, "figma-font-sync-1.2.0.exe"), "utf8")).toBe("console exe");
    expect(await readFile(background, "utf8")).toBe("background exe");
  });

  it("on Windows finds the background exe of a release download by its own name", async () => {
    const exec = await binary("figma-font-sync-windows-x64.exe", "console exe");
    await binary("figma-font-sync-windows-x64-background.exe", "background exe");
    const runtime = await installRuntime(input("win32", exec));
    expect(runtime.serveCommand[0]).toBe(path.join(binDir, "figma-font-sync-1.2.0-background.exe"));
    expect(await readFile(runtime.serveCommand[0] ?? "", "utf8")).toBe("background exe");
  });

  it("on Windows keeps working when run from the runtime copy itself", async () => {
    const exec = await binary("figma-font-sync.exe", "console exe");
    await binary("figma-font-sync-background.exe", "background exe");
    await installRuntime(input("win32", exec));
    const runtime = await installRuntime(input("win32", path.join(binDir, "figma-font-sync-1.2.0.exe")));
    expect(runtime.serveCommand[0]).toBe(path.join(binDir, "figma-font-sync-1.2.0-background.exe"));
    expect((await readdir(binDir)).sort()).toEqual(["figma-font-sync-1.2.0-background.exe", "figma-font-sync-1.2.0.exe"]);
  });

  it("on Windows refuses to go on without a background exe", async () => {
    const exec = await binary("figma-font-sync.exe", "console exe");
    await expect(installRuntime(input("win32", exec))).rejects.toThrow("figma-font-sync-background.exe");
  });
});
