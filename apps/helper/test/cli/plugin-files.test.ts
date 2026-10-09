import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { figmaImportSteps, installPluginFiles, pluginSourceDir } from "../../src/cli/plugin-files";

let root: string;
let source: string;
let dataDir: string;

const MANIFEST = { name: "Font Sync", id: "font-sync-internal", api: "1.0.0", main: "dist/code.js", ui: "dist/ui.html" };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "font-sync-plugin-files-"));
  source = path.join(root, "plugin");
  dataDir = path.join(root, "data");
  await mkdir(path.join(source, "dist"), { recursive: true });
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "manifest.json"), JSON.stringify(MANIFEST));
  await writeFile(path.join(source, "dist", "code.js"), "code v1");
  await writeFile(path.join(source, "dist", "ui.html"), "<p>ui v1</p>");
  // Present in apps/plugin but not named by the manifest, so never copied.
  await writeFile(path.join(source, "src", "main.ts"), "source");
  await writeFile(path.join(source, "dist", "stale.js"), "old build output");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

describe("pluginSourceDir", () => {
  it("reads the embedded copy inside a compiled binary", () => {
    expect(pluginSourceDir(true, "/$bunfs/root")).toBe("/$bunfs/root/figma-plugin");
    expect(pluginSourceDir(true, "B:/~BUN/root")).toBe("B:/~BUN/root/figma-plugin");
  });

  it("reads apps/plugin from source", async () => {
    const helperCli = path.resolve(import.meta.dir, "../../src/cli");
    const dir = pluginSourceDir(false, helperCli);
    expect(dir).toBe(path.resolve(import.meta.dir, "../../../plugin"));
    expect(await Bun.file(path.join(dir, "manifest.json")).exists()).toBe(true);
  });
});

describe("installPluginFiles", () => {
  it("copies the manifest and the files it names, and nothing else", async () => {
    const result = await installPluginFiles(dataDir, "1.2.0", source);
    const dir = path.join(dataDir, "figma-plugin");
    expect(result).toEqual({ dir, manifestPath: path.join(dir, "manifest.json"), updated: true });
    expect(await listTree(dir)).toEqual([".version", "dist/code.js", "dist/ui.html", "manifest.json"]);
    expect(await readFile(path.join(dir, "dist", "ui.html"), "utf8")).toBe("<p>ui v1</p>");
    expect(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"))).toEqual(MANIFEST);
    expect((await readFile(path.join(dir, ".version"), "utf8")).trim()).toBe("1.2.0");
  });

  it("does nothing when the files are already there for this version", async () => {
    await installPluginFiles(dataDir, "1.2.0", source);
    await writeFile(path.join(source, "dist", "code.js"), "code v2");
    const again = await installPluginFiles(dataDir, "1.2.0", source);
    expect(again.updated).toBe(false);
    expect(await readFile(path.join(dataDir, "figma-plugin", "dist", "code.js"), "utf8")).toBe("code v1");
  });

  it("rewrites the files for another version at the same manifest path", async () => {
    const first = await installPluginFiles(dataDir, "1.2.0", source);
    await writeFile(path.join(source, "dist", "code.js"), "code v2");
    const second = await installPluginFiles(dataDir, "1.3.0", source);
    expect(second).toEqual({ ...first, updated: true });
    expect(await readFile(path.join(dataDir, "figma-plugin", "dist", "code.js"), "utf8")).toBe("code v2");
    expect((await readFile(path.join(dataDir, "figma-plugin", ".version"), "utf8")).trim()).toBe("1.3.0");
  });

  it("rewrites the files when the manifest went missing", async () => {
    await installPluginFiles(dataDir, "1.2.0", source);
    await rm(path.join(dataDir, "figma-plugin", "manifest.json"));
    expect((await installPluginFiles(dataDir, "1.2.0", source)).updated).toBe(true);
    expect(await Bun.file(path.join(dataDir, "figma-plugin", "manifest.json")).exists()).toBe(true);
  });

  it("copies every ui entry when ui is an object", async () => {
    await writeFile(path.join(source, "dist", "settings.html"), "settings");
    await writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify({ ...MANIFEST, ui: { main: "dist/ui.html", settings: "./dist/settings.html" } }),
    );
    await installPluginFiles(dataDir, "1.2.0", source);
    expect(await listTree(path.join(dataDir, "figma-plugin"))).toEqual([
      ".version",
      "dist/code.js",
      "dist/settings.html",
      "dist/ui.html",
      "manifest.json",
    ]);
  });

  it("says to build the plugin when the source has no manifest", async () => {
    await rm(path.join(source, "manifest.json"));
    await expect(installPluginFiles(dataDir, "1.2.0", source)).rejects.toThrow("bun run --cwd apps/plugin build");
  });

  it("says to build the plugin when a named file is missing, and leaves no marker", async () => {
    await rm(path.join(source, "dist", "ui.html"));
    await expect(installPluginFiles(dataDir, "1.2.0", source)).rejects.toThrow("dist/ui.html");
    expect(await Bun.file(path.join(dataDir, "figma-plugin", ".version")).exists()).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "drops the marker before copying, so a copy cut short is retried",
    async () => {
      await installPluginFiles(dataDir, "1.2.0", source);
      const dir = path.join(dataDir, "figma-plugin");
      // The marker matches but the manifest is gone, and ui.html refuses writes: the copy fails halfway.
      await rm(path.join(dir, "manifest.json"));
      await chmod(path.join(dir, "dist", "ui.html"), 0o444);
      try {
        await expect(installPluginFiles(dataDir, "1.2.0", source)).rejects.toThrow();
      } finally {
        await chmod(path.join(dir, "dist", "ui.html"), 0o644);
      }
      expect(await Bun.file(path.join(dir, ".version")).exists()).toBe(false);
      expect((await installPluginFiles(dataDir, "1.2.0", source)).updated).toBe(true);
      expect(await Bun.file(path.join(dir, "manifest.json")).exists()).toBe(true);
    },
  );

  it("refuses a manifest that names files outside the plugin folder", async () => {
    await writeFile(path.join(source, "manifest.json"), JSON.stringify({ ...MANIFEST, main: "../../outside.js" }));
    await expect(installPluginFiles(dataDir, "1.2.0", source)).rejects.toThrow("outside the plugin folder");
    await writeFile(path.join(source, "manifest.json"), JSON.stringify({ ...MANIFEST, main: "/etc/passwd" }));
    await expect(installPluginFiles(dataDir, "1.2.0", source)).rejects.toThrow("outside the plugin folder");
  });

  it("installs the real plugin build from the repo when it has been built", async () => {
    const repoPlugin = pluginSourceDir(false, path.resolve(import.meta.dir, "../../src/cli"));
    const built = await Bun.file(path.join(repoPlugin, "dist", "code.js")).exists();
    if (!built) return;
    const result = await installPluginFiles(dataDir, "1.2.0", repoPlugin);
    expect(await listTree(result.dir)).toEqual([".version", "dist/code.js", "dist/ui.html", "manifest.json"]);
  });
});

describe("figmaImportSteps", () => {
  const manifest = "/Users/ana/Library/Application Support/font-sync/figma-plugin/manifest.json";

  it("walks through the import on macOS, including the hidden Library folder", () => {
    const text = figmaImportSteps(manifest, "darwin").join("\n");
    expect(text).toContain("Figma desktop");
    expect(text).toContain("Plugins > Development > Import plugin from manifest...");
    expect(text).toContain(`Choose ${manifest}`);
    expect(text).toContain("Cmd+Shift+G");
    expect(text).toContain("Plugins > Development > Font Sync");
    expect(text).toContain("without importing again");
  });

  it("uses the File name box on Windows", () => {
    const winManifest = "C:\\Users\\ana\\AppData\\Local\\font-sync\\figma-plugin\\manifest.json";
    const text = figmaImportSteps(winManifest, "win32").join("\n");
    expect(text).toContain(`Choose ${winManifest}`);
    expect(text).toContain("File name");
    expect(text).not.toContain("Cmd+Shift+G");
  });

  it("explains that Linux has no Figma desktop", () => {
    const text = figmaImportSteps("/home/ana/.local/share/font-sync/figma-plugin/manifest.json", "linux").join("\n");
    expect(text).toContain("macOS and Windows");
  });
});
