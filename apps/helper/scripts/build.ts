import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
  "bun-linux-x64",
] as const satisfies readonly Bun.Build.CompileTarget[];
type Target = (typeof TARGETS)[number];

/** Baked in only when set at build time, so a binary built without them still reads the runtime env. */
const BUILD_TIME_ENV = ["FONT_SYNC_GOOGLE_CLIENT_ID", "FONT_SYNC_GOOGLE_CLIENT_SECRET"] as const;

const helperDir = resolve(import.meta.dir, "..");
const pluginDir = resolve(helperDir, "../plugin");
const distDir = join(helperDir, "dist");
// The binary finds it at join(import.meta.dir, "figma-plugin"): compile.assets embeds a directory under its basename.
const pluginOut = join(distDir, "figma-plugin");

function fail(message: string): never {
  console.error(`build: ${message}`);
  process.exit(1);
}

function selectedTargets(value: string | undefined): Target[] {
  if (!value) return [...TARGETS];
  return value.split(",").map((raw) => {
    const name = raw.trim();
    const target = TARGETS.find((t) => t === name);
    if (!target) fail(`Unknown target "${name}" in FONT_SYNC_TARGETS. Known: ${TARGETS.join(", ")}`);
    return target;
  });
}

/** The manifest's main and ui point into apps/plugin/dist; both must exist before anything is packaged. */
async function checkPluginBuilt(): Promise<void> {
  const manifestFile = Bun.file(join(pluginDir, "manifest.json"));
  if (!(await manifestFile.exists())) fail(`apps/plugin/manifest.json is missing (looked in ${pluginDir}).`);
  const manifest: { main?: unknown; ui?: unknown } = await manifestFile.json();
  for (const entry of [manifest.main, manifest.ui]) {
    if (typeof entry !== "string") continue;
    if (!(await Bun.file(join(pluginDir, entry)).exists())) {
      fail(`apps/plugin/${entry} is missing. Build the plugin first: bun run --cwd apps/plugin build`);
    }
  }
}

function outfileFor(target: Target, suffix = ""): string {
  const [, os, arch] = target.split("-");
  return join(distDir, `figma-font-sync-${os}-${arch}${suffix}${os === "windows" ? ".exe" : ""}`);
}

async function run(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) fail(`${argv.join(" ")} exited with code ${code}`);
}

const targets = selectedTargets(process.env.FONT_SYNC_TARGETS);
await checkPluginBuilt();

const define: Record<string, string> = {};
for (const name of BUILD_TIME_ENV) {
  const value = process.env[name];
  if (value) define[`process.env.${name}`] = JSON.stringify(value);
}
if (process.env.FONT_SYNC_PUBLIC_BUILD === "1") {
  // Anyone can download a published binary and read the strings in it.
  const baked = BUILD_TIME_ENV.filter((name) => process.env[name]);
  if (baked.length > 0) {
    fail(
      `FONT_SYNC_PUBLIC_BUILD=1 needs ${baked.join(" and ")} unset: public builds never carry a Google client. ` +
        "Bun also reads them from a .env file in the current directory.",
    );
  }
} else if (!define["process.env.FONT_SYNC_GOOGLE_CLIENT_ID"]) {
  console.warn("build: no Google client baked in; users add one with `figma-font-sync setup` or the env vars.");
}

await rm(pluginOut, { recursive: true, force: true });
await mkdir(pluginOut, { recursive: true });
await cp(join(pluginDir, "manifest.json"), join(pluginOut, "manifest.json"));
// Keep the dist/ folder: manifest.json refers to dist/code.js and dist/ui.html.
await cp(join(pluginDir, "dist"), join(pluginOut, "dist"), { recursive: true });
console.log(`staged the Figma plugin in ${pluginOut}`);

for (const target of targets) {
  // Windows start-at-login runs a copy with no console window; a console program started from the Run key
  // opens one at every login. That copy cannot print, so the CLI stays a console program.
  const variants = target === "bun-windows-x64" ? [false, true] : [false];
  for (const hideConsole of variants) {
    const outfile = outfileFor(target, hideConsole ? "-background" : "");
    const result = await Bun.build({
      entrypoints: [join(helperDir, "src/main.ts")],
      // A .env or bunfig.toml in whatever directory the binary starts in must not change its behaviour.
      compile: {
        target,
        outfile,
        assets: [pluginOut],
        autoloadDotenv: false,
        autoloadBunfig: false,
        ...(hideConsole ? { windows: { hideConsole: true } } : {}),
      },
      minify: true,
      define,
      throw: false,
    });
    if (!result.success) fail(`${target} failed:\n${result.logs.join("\n")}`);
    // Bun 1.4.0 writes darwin-arm64 binaries with an invalid signature (oven-sh/bun#39764), and no Bun version
    // re-signs darwin-x64 output after patching it. macOS 27 kills binaries whose pages fail the signature.
    if (process.platform === "darwin" && target.startsWith("bun-darwin")) {
      await run(["codesign", "--force", "--sign", "-", outfile]);
      await run(["codesign", "--verify", "--strict", outfile]);
    }
    // pack-npm.ts and npm pack keep the mode they find, so this is what lands on users' machines.
    await chmod(outfile, 0o755);
    console.log(`built ${outfile}`);
  }
}
