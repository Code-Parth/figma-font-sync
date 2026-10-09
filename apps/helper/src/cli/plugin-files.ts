import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../config/paths";

export type PluginInstall = {
  /** `<dataDir>/figma-plugin` */
  dir: string;
  manifestPath: string;
  /** False when the files were already there for this version. */
  updated: boolean;
};

/**
 * Where manifest.json and dist/ come from: `join(metaDir, "figma-plugin")` inside a compiled binary
 * (embedded through compile.assets), otherwise the repo's apps/plugin.
 */
export function pluginSourceDir(standalone: boolean, metaDir: string): string {
  // Embedded files live under /$bunfs/root (B:/~BUN/root on Windows), which always uses forward slashes.
  if (standalone) return path.posix.join(metaDir, "figma-plugin");
  // metaDir is apps/helper/src/cli when running from source.
  return path.resolve(metaDir, "../../../plugin");
}

/**
 * Writes manifest.json and the files it names (main, ui) from `sourceDir` to `<dataDir>/figma-plugin` and
 * records `version` in `.version` there, unless `.version` already says `version` and manifest.json exists.
 * Files are copied with Bun.file + Bun.write because fs.cp cannot read the compiled binary's /$bunfs. Throws
 * a clear error when sourceDir lacks manifest.json or the files it names (plugin not built yet, from source).
 */
export async function installPluginFiles(dataDir: string, version: string, sourceDir: string): Promise<PluginInstall> {
  const dir = path.join(dataDir, "figma-plugin");
  const manifestPath = path.join(dir, "manifest.json");
  const marker = path.join(dir, ".version");
  const installed = (await Bun.file(marker).exists()) ? (await Bun.file(marker).text()).trim() : null;
  if (installed === version && (await Bun.file(manifestPath).exists())) return { dir, manifestPath, updated: false };

  const manifestSource = Bun.file(joinSource(sourceDir, "manifest.json"));
  if (!(await manifestSource.exists())) {
    throw new Error(`No Figma plugin manifest at ${joinSource(sourceDir, "manifest.json")}.${BUILD_HINT}`);
  }
  const files = manifestFiles(await manifestSource.json());
  for (const file of files) {
    if (!(await Bun.file(joinSource(sourceDir, file)).exists())) {
      throw new Error(`The plugin manifest names ${file}, which is missing from ${sourceDir}.${BUILD_HINT}`);
    }
  }

  // Without a marker every later call rewrites the files, so a copy cut short is finished next time.
  await rm(marker, { force: true });
  // The manifest goes after the files it names, so Figma never reads one that points at missing files.
  for (const file of [...files, "manifest.json"]) {
    const target = path.join(dir, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await Bun.write(target, Bun.file(joinSource(sourceDir, file)));
  }
  await Bun.write(marker, `${version}\n`);
  return { dir, manifestPath, updated: true };
}

const BUILD_HINT = " From source, build the plugin first: bun run --cwd apps/plugin build";

/** Forward slashes suit the embedded /$bunfs and B:/~BUN paths, and Windows accepts them in disk paths too. */
function joinSource(sourceDir: string, relative: string): string {
  return path.posix.join(sourceDir, relative);
}

/** `main` and every `ui` entry (a string, or an object of strings) as safe relative paths. */
function manifestFiles(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null) throw new Error("The plugin manifest is not a JSON object.");
  const { main, ui } = manifest as { main?: unknown; ui?: unknown };
  const entries = [main, ...(typeof ui === "object" && ui !== null ? Object.values(ui) : [ui])];
  const files = entries.filter((entry): entry is string => typeof entry === "string");
  for (const file of files) {
    const normalized = path.posix.normalize(file);
    if (path.posix.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("\\")) {
      throw new Error(`The plugin manifest names ${file}, which is outside the plugin folder.`);
    }
  }
  return [...new Set(files.map((file) => path.posix.normalize(file)))];
}

/** Lines telling the user how to import the manifest in Figma desktop on this platform. */
export function figmaImportSteps(manifestPath: string, platform: Platform): string[] {
  if (platform === "linux") {
    return [
      "Only Figma desktop can import a development plugin, and it runs on macOS and Windows only.",
      `Run "figma-font-sync setup" on a Mac or Windows machine to import the plugin there.`,
    ];
  }
  const picker =
    platform === "darwin"
      ? "In the file dialog press Cmd+Shift+G, paste the path and press Return (the Library folder is hidden)."
      : "In the file dialog paste the path into the File name box and press Enter.";
  return [
    "In Figma desktop, open any design file.",
    "Open the main menu (the Figma logo) > Plugins > Development > Import plugin from manifest...",
    `Choose ${manifestPath}`,
    picker,
    "Then run it from Plugins > Development > Font Sync.",
    "Upgrades keep this path, so Figma picks up new plugin versions without importing again.",
  ];
}
