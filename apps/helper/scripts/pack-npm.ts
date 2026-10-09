// Lays out the npm packages from the binaries scripts/build.ts wrote (docs/distribution.md, "Packages"):
//   bun scripts/pack-npm.ts                     every platform must be built
//   bun scripts/pack-npm.ts --partial           only the built ones, for local and CI smoke tests
//   bun scripts/pack-npm.ts --dist <dir> --out <dir>
// Output: <out>/figma-font-sync/ and <out>/<os>-<arch>/, ready for npm pack or npm publish.

import { chmod, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";

const MAIN_NAME = "figma-font-sync";
const SCOPE = "@figma-font-sync";
const REPOSITORY = { type: "git", url: "git+https://github.com/Code-Parth/font-sync.git" };
const LICENSE = "SEE LICENSE IN LICENSE";
const AUTHOR = "Parth Parmar";
const VERSION_PLACEHOLDER = "__VERSION__";
// From the repo root: Bun loads apps/helper/.env into scripts run from apps/helper, and that client would be baked in.
const PUBLIC_BUILD = "FONT_SYNC_PUBLIC_BUILD=1 bun --no-env-file apps/helper/scripts/build.ts";
/** The pattern docs/releasing.md greps for: a Google client ID or client secret among a binary's strings. */
const GOOGLE_CLIENT = /GOCSPX-[A-Za-z0-9_-]{20,}|[0-9]{6,}-[a-z0-9]{32}\.apps\.googleusercontent\.com/;

type Platform = {
  /** Package `@figma-font-sync/<suffix>` and its directory under --out. Says windows, not win32. */
  suffix: string;
  label: string;
  os: string;
  cpu: string;
  libc?: string;
  /** build.ts output name in --dist, and the name it gets in the package's bin/. */
  binaries: { from: string; to: string }[];
};

const PLATFORMS: Platform[] = [
  {
    suffix: "darwin-arm64",
    label: "macOS arm64",
    os: "darwin",
    cpu: "arm64",
    binaries: [{ from: "figma-font-sync-darwin-arm64", to: "figma-font-sync" }],
  },
  {
    suffix: "darwin-x64",
    label: "macOS x64",
    os: "darwin",
    cpu: "x64",
    binaries: [{ from: "figma-font-sync-darwin-x64", to: "figma-font-sync" }],
  },
  {
    suffix: "windows-x64",
    label: "Windows x64",
    os: "win32",
    cpu: "x64",
    binaries: [
      { from: "figma-font-sync-windows-x64.exe", to: "figma-font-sync.exe" },
      { from: "figma-font-sync-windows-x64-background.exe", to: "figma-font-sync-background.exe" },
    ],
  },
  {
    suffix: "linux-x64",
    label: "Linux x64 (glibc)",
    os: "linux",
    cpu: "x64",
    // npm applies libc only when os is linux; Bun builds only against glibc.
    libc: "glibc",
    binaries: [{ from: "figma-font-sync-linux-x64", to: "figma-font-sync" }],
  },
];

const helperDir = resolve(import.meta.dir, "..");
const repoDir = resolve(helperDir, "../..");

function fail(message: string): never {
  console.error(`pack-npm: ${message}`);
  process.exit(1);
}

function packageName(platform: Platform): string {
  return `${SCOPE}/${platform.suffix}`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function containsGoogleClient(file: string): Promise<boolean> {
  // latin1 maps each byte to one character, so ASCII strings survive the binary bytes around them.
  return GOOGLE_CLIENT.test(Buffer.from(await Bun.file(file).arrayBuffer()).toString("latin1"));
}

/** npm always ships README and LICENSE, whatever `files` says. */
async function copyLicense(dir: string): Promise<boolean> {
  const source = join(repoDir, "LICENSE");
  if (!(await exists(source))) return false;
  await copyFile(source, join(dir, "LICENSE"));
  return true;
}

async function writePlatformPackage(platform: Platform, distDir: string, dir: string, version: string): Promise<void> {
  await mkdir(join(dir, "bin"), { recursive: true });
  for (const { from, to } of platform.binaries) {
    const target = join(dir, "bin", to);
    await copyFile(join(distDir, from), target);
    // npm pack records the mode it finds; without the exec bit the launcher gets EACCES.
    await chmod(target, 0o755);
  }
  await writeJson(join(dir, "package.json"), {
    name: packageName(platform),
    version,
    description: `The ${MAIN_NAME} binary for ${platform.label}. Install ${MAIN_NAME} instead.`,
    repository: REPOSITORY,
    license: LICENSE,
    author: AUTHOR,
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc ? { libc: [platform.libc] } : {}),
    preferUnplugged: true,
    files: ["bin"],
    publishConfig: { access: "public" },
  });
  await Bun.write(
    join(dir, "README.md"),
    `# ${packageName(platform)}\n\nThe \`${MAIN_NAME}\` binary for ${platform.label}. ` +
      `Install [${MAIN_NAME}](https://www.npmjs.com/package/${MAIN_NAME}) instead:\n\n` +
      `\`\`\`bash\nnpm i -g ${MAIN_NAME}\n\`\`\`\n`,
  );
  await copyLicense(dir);
}

async function writeMainPackage(dir: string, version: string, built: Platform[]): Promise<void> {
  await mkdir(join(dir, "bin"), { recursive: true });
  const launcher = join(dir, "bin", `${MAIN_NAME}.js`);
  await copyFile(join(repoDir, "packaging/npm/bin", `${MAIN_NAME}.js`), launcher);
  await chmod(launcher, 0o755);

  const script = await Bun.file(join(repoDir, "packaging/install.sh")).text();
  const placeholders = script.split(VERSION_PLACEHOLDER).length - 1;
  if (placeholders !== 1) {
    fail(`packaging/install.sh must contain ${VERSION_PLACEHOLDER} exactly once, found ${placeholders}.`);
  }
  const installSh = join(dir, "install.sh");
  await Bun.write(installSh, script.replace(VERSION_PLACEHOLDER, version));
  await chmod(installSh, 0o755);

  await copyFile(join(repoDir, "README.md"), join(dir, "README.md"));
  if (!(await copyLicense(dir))) {
    console.warn(`pack-npm: ${join(repoDir, "LICENSE")} is missing; ${MAIN_NAME} will ship without it.`);
  }

  await writeJson(join(dir, "package.json"), {
    name: MAIN_NAME,
    version,
    description: "Installs the fonts a Figma file uses from your team's shared Google Drive folder.",
    keywords: ["figma", "figma-plugin", "fonts", "font-installer", "google-drive", "cli"],
    homepage: `https://www.npmjs.com/package/${MAIN_NAME}`,
    repository: REPOSITORY,
    license: LICENSE,
    author: AUTHOR,
    bin: { [MAIN_NAME]: `bin/${MAIN_NAME}.js` },
    files: ["bin", "install.sh", "README.md", "LICENSE"],
    engines: { node: ">=18" },
    // Exact versions: the launcher refuses a platform package whose version differs from its own.
    optionalDependencies: Object.fromEntries(built.map((platform) => [packageName(platform), version])),
  });
}

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    dist: { type: "string" },
    out: { type: "string" },
    partial: { type: "boolean", default: false },
  },
});
const distDir = resolve(args.dist ?? join(helperDir, "dist"));
const outDir = resolve(args.out ?? join(distDir, "npm"));
const version = pkg.version;
// The version lands in install.sh and in registry URLs, so only semver characters get through.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`apps/helper/package.json has version "${version}", which is not semver.`);
}

const built: Platform[] = [];
const missing: string[] = [];
for (const platform of PLATFORMS) {
  const present = await Promise.all(platform.binaries.map(({ from }) => exists(join(distDir, from))));
  if (present.every(Boolean)) {
    built.push(platform);
    continue;
  }
  const absent = platform.binaries.filter((_, i) => !present[i]).map(({ from }) => from);
  // A Windows package with one of its two executables would install but fail at start-at-login.
  if (present.some(Boolean)) fail(`${packageName(platform)} is incomplete: ${absent.join(", ")} missing in ${distDir}.`);
  missing.push(...absent);
}
if (built.length === 0) fail(`no binaries in ${distDir}. Build them first: ${PUBLIC_BUILD}`);
if (missing.length > 0 && !args.partial) {
  fail(`missing in ${distDir}: ${missing.join(", ")}. Build every target, or pass --partial for a local smoke test.`);
}

// Invariant 11, checked on the files themselves: build.ts bakes in any client it finds in the environment and
// leaves old outputs in dist, so how the binaries were meant to be built proves nothing.
const leaking: string[] = [];
for (const platform of built) {
  for (const { from } of platform.binaries) {
    if (await containsGoogleClient(join(distDir, from))) leaking.push(from);
  }
}
if (leaking.length > 0) {
  fail(`a Google client is baked into ${leaking.join(", ")} in ${distDir}. Never publish it; rebuild: ${PUBLIC_BUILD}`);
}

// Stale platform directories from an earlier run would otherwise be published with the wrong binaries.
for (const dir of [MAIN_NAME, ...PLATFORMS.map((platform) => platform.suffix)]) {
  await rm(join(outDir, dir), { recursive: true, force: true });
}

const written: string[] = [];
for (const platform of built) {
  const dir = join(outDir, platform.suffix);
  await writePlatformPackage(platform, distDir, dir, version);
  written.push(dir);
}
const mainDir = join(outDir, MAIN_NAME);
await writeMainPackage(mainDir, version, built);
written.push(mainDir);

for (const dir of written) console.log(`${dir}  ${formatSize(await directorySize(dir))}`);
if (missing.length > 0) console.warn(`pack-npm: --partial: left out ${missing.join(", ")}`);
