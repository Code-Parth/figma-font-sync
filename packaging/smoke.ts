// Installs the npm packages pack-npm.ts wrote for this machine the way users do, and runs them. CI runs it
// after building only the host target:
//   bun apps/helper/scripts/pack-npm.ts --partial && bun packaging/smoke.ts [--out <pack-npm output>]
// 1. npm pack figma-font-sync and this platform's package, npm install -g both into a temporary prefix.
// 2. Run `figma-font-sync version` and `figma-font-sync plugin` through npm's shim with a temporary home.
// 3. macOS and Linux: install the platform tarball with install.sh --from and run `version` again.

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentPlatform, resolvePaths } from "../apps/helper/src/config/paths";

const SUFFIXES: Record<string, string> = {
  "darwin/arm64": "darwin-arm64",
  "darwin/x64": "darwin-x64",
  "win32/x64": "windows-x64",
  "linux/x64": "linux-x64",
};

const repoDir = resolve(import.meta.dir, "..");
const isWindows = process.platform === "win32";

function fail(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

/** Runs a command to completion; npm and its shims are .cmd files on Windows, which only a shell can start. */
function run(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const quote = (value: string) => (isWindows && /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(isWindows ? quote(command) : command, isWindows ? args.map(quote) : args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    shell: isWindows,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  return result.stdout;
}

/** npm pack, returning the tarball's path. */
function npmPack(dir: string, destination: string): string {
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", destination], { cwd: dir })) as {
    filename: string;
  }[];
  if (!packed) fail(`npm pack wrote nothing for ${dir}`);
  return join(destination, packed.filename);
}

const { values: args } = parseArgs({ args: Bun.argv.slice(2), options: { out: { type: "string" } } });
const outDir = resolve(args.out ?? join(repoDir, "apps/helper/dist/npm"));
const suffix = SUFFIXES[`${process.platform}/${process.arch}`] ?? fail(`no package for ${process.platform} ${process.arch}`);
const mainDir = join(outDir, "figma-font-sync");
const platformDir = join(outDir, suffix);
const { version } = (await Bun.file(join(mainDir, "package.json")).json()) as { version: string };
if (!(await Bun.file(join(platformDir, "package.json")).exists())) {
  fail(`${platformDir} is missing. Build this platform and run pack-npm.ts --partial first.`);
}

const work = await mkdtemp(join(tmpdir(), "figma-font-sync-smoke-"));
try {
  const tarballs = join(work, "tarballs");
  await mkdir(tarballs);
  const mainTarball = npmPack(mainDir, tarballs);
  const platformTarball = npmPack(platformDir, tarballs);

  const prefix = join(work, "prefix");
  run("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", mainTarball, platformTarball]);
  // npm puts global shims in <prefix> on Windows and <prefix>/bin elsewhere.
  const cli = isWindows ? join(prefix, "figma-font-sync.cmd") : join(prefix, "bin", "figma-font-sync");

  // Everything the binary writes lands here, never in the real home of whoever runs this.
  const home = join(work, "home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
  for (const name of ["FIGMA_FONT_SYNC_BINARY", "FONT_SYNC_GOOGLE_CLIENT_ID", "FONT_SYNC_GOOGLE_CLIENT_SECRET"]) {
    delete env[name];
  }
  await mkdir(env.APPDATA!, { recursive: true });
  await mkdir(env.LOCALAPPDATA!, { recursive: true });

  const printed = run(cli, ["version"], { env });
  if (!printed.includes(version)) fail(`figma-font-sync version printed "${printed.trim()}", expected ${version}`);

  run(cli, ["plugin"], { env });
  const pluginDir = join(resolvePaths(currentPlatform(), env, home).dataDir, "figma-plugin");
  const written = (await readdir(pluginDir, { recursive: true })).map(String).sort();
  for (const file of ["manifest.json", join("dist", "code.js"), join("dist", "ui.html")]) {
    if (!written.includes(file)) fail(`figma-font-sync plugin did not write ${file} in ${pluginDir}: ${written.join(", ")}`);
  }
  const staged = await Bun.file(join(repoDir, "apps/helper/dist/figma-plugin/manifest.json")).text();
  if ((await Bun.file(join(pluginDir, "manifest.json")).text()) !== staged) {
    fail("the manifest.json the binary wrote differs from apps/helper/dist/figma-plugin/manifest.json");
  }

  if (!isWindows) {
    const installDir = join(work, "install-sh-bin");
    run("sh", [join(mainDir, "install.sh"), "--from", platformTarball, "--no-setup"], {
      env: { ...env, FIGMA_FONT_SYNC_INSTALL_DIR: installDir },
    });
    const installed = run(join(installDir, "figma-font-sync"), ["version"], { env });
    if (!installed.includes(version)) fail(`the install.sh copy printed "${installed.trim()}", expected ${version}`);
  }

  console.log(`smoke: figma-font-sync ${version} for ${suffix} installs and runs`);
} finally {
  await rm(work, { recursive: true, force: true });
}
