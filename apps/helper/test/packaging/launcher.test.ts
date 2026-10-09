import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LAUNCHER = path.resolve(import.meta.dir, "../../../../packaging/npm/bin/figma-font-sync.js");
const NODE = Bun.which("node");
const IS_WINDOWS = process.platform === "win32";

const SUFFIXES: Record<string, string> = {
  "darwin/arm64": "darwin-arm64",
  "darwin/x64": "darwin-x64",
  "win32/x64": "windows-x64",
  "linux/x64": "linux-x64",
};
/** What the launcher looks for on this host, or undefined where no build exists. */
const HOST = SUFFIXES[`${process.platform}/${process.arch}`];

// The fake native binary is Node itself: it is executable on every OS, and the launcher passes our
// `-e <script>` through as argv. A shell script would not do on Windows, where spawn refuses .cmd files.
const PRINT_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

let root: string;
let fakeBinary: string;

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

/** node_modules/figma-font-sync with the launcher, and optionally the platform package beside it. */
async function layout(name: string, opts: { mainVersion?: string; platform?: string; platformVersion?: string } = {}) {
  const dir = path.join(root, name);
  const main = path.join(dir, "node_modules", "figma-font-sync");
  await writeJson(path.join(main, "package.json"), { name: "figma-font-sync", version: opts.mainVersion ?? "1.2.3" });
  await mkdir(path.join(main, "bin"), { recursive: true });
  await copyFile(LAUNCHER, path.join(main, "bin", "figma-font-sync.js"));
  if (opts.platform) {
    const pkg = path.join(dir, "node_modules", "@figma-font-sync", opts.platform);
    await writeJson(path.join(pkg, "package.json"), {
      name: `@figma-font-sync/${opts.platform}`,
      version: opts.platformVersion ?? "1.2.3",
    });
    await mkdir(path.join(pkg, "bin"), { recursive: true });
    const exe = path.join(pkg, "bin", opts.platform.startsWith("windows") ? "figma-font-sync.exe" : "figma-font-sync");
    await (IS_WINDOWS ? copyFile(fakeBinary, exe) : symlink(fakeBinary, exe));
  }
  return path.join(main, "bin", "figma-font-sync.js");
}

/** A -r preload that makes the launcher see another platform. */
async function preload(name: string, platform: string, arch: string, glibc: string | undefined): Promise<string> {
  const file = path.join(root, `${name}.cjs`);
  const header = glibc ? `{ glibcVersionRuntime: ${JSON.stringify(glibc)} }` : "{}";
  await writeFile(
    file,
    [
      `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
      `Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });`,
      `process.report.getReport = () => ({ header: ${header} });`,
    ].join("\n"),
  );
  return file;
}

async function launch(launcher: string, args: string[], opts: { env?: Record<string, string>; preload?: string } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  if (!opts.env?.FIGMA_FONT_SYNC_BINARY) delete env.FIGMA_FONT_SYNC_BINARY;
  const child = Bun.spawn([NODE!, ...(opts.preload ? ["-r", opts.preload] : []), launcher, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode, signalCode: child.signalCode };
}

describe.skipIf(!NODE)("npm launcher", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "font-sync-launcher-"));
    fakeBinary = path.join(root, IS_WINDOWS ? "node.exe" : "node");
    await (IS_WINDOWS ? copyFile(NODE!, fakeBinary) : symlink(NODE!, fakeBinary));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe.skipIf(!HOST)("with this host's platform package", () => {
    it("passes argv through untouched", async () => {
      const launcher = await layout("argv", { platform: HOST });
      const result = await launch(launcher, ["-e", PRINT_ARGV, "a b", "--flag", ""]);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(["a b", "--flag", ""]);
      expect(result.exitCode).toBe(0);
    });

    it("exits with the binary's exit code", async () => {
      const launcher = await layout("exit", { platform: HOST });
      expect((await launch(launcher, ["-e", "process.exit(7)"])).exitCode).toBe(7);
    });

    it.skipIf(IS_WINDOWS)("dies of the signal that killed the binary", async () => {
      const launcher = await layout("signal", { platform: HOST });
      const result = await launch(launcher, ["-e", "process.kill(process.pid, 'SIGTERM')"]);
      expect(result.signalCode).toBe("SIGTERM");
    });

    it("refuses a platform package of another version", async () => {
      const launcher = await layout("skew", { platform: HOST, platformVersion: "1.2.2" });
      const result = await launch(launcher, ["-e", PRINT_ARGV]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`@figma-font-sync/${HOST} is 1.2.2 but figma-font-sync is 1.2.3`);
      expect(result.stderr).toContain("npm i -g figma-font-sync@1.2.3");
    });

    it("says how to reinstall when the platform package is missing", async () => {
      const launcher = await layout("missing");
      const result = await launch(launcher, []);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`the package @figma-font-sync/${HOST} is missing`);
      expect(result.stderr).toContain("--omit=optional");
      expect(result.stderr).toContain("npm i -g figma-font-sync@1.2.3");
    });
  });

  it("runs FIGMA_FONT_SYNC_BINARY without a platform package", async () => {
    const launcher = await layout("override");
    const result = await launch(launcher, ["-e", PRINT_ARGV, "x"], { env: { FIGMA_FONT_SYNC_BINARY: fakeBinary } });
    expect(JSON.parse(result.stdout)).toEqual(["x"]);
    expect(result.exitCode).toBe(0);
  });

  it("reports a binary it cannot start", async () => {
    const launcher = await layout("bad-override");
    const missing = path.join(root, "no-such-binary");
    const result = await launch(launcher, [], { env: { FIGMA_FONT_SYNC_BINARY: missing } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`could not run ${missing}`);
  });

  it("lists the supported platforms on an unsupported one", async () => {
    const launcher = await layout("freebsd");
    const result = await launch(launcher, [], { preload: await preload("freebsd", "freebsd", "x64", undefined) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("there is no build for freebsd x64");
    expect(result.stderr).toContain("Supported: macOS arm64, macOS x64, Windows x64 and Linux x64 (glibc)");
  });

  it("refuses musl Linux before looking for a package", async () => {
    const launcher = await layout("musl");
    const result = await launch(launcher, [], { preload: await preload("musl", "linux", "x64", undefined) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("musl libc");
  });

  // On Windows the extensionless linux binary name would get .exe appended by CreateProcess.
  it.skipIf(IS_WINDOWS)("runs the glibc Linux package", async () => {
    const launcher = await layout("glibc", { platform: "linux-x64" });
    const result = await launch(launcher, ["-e", PRINT_ARGV, "ok"], {
      preload: await preload("glibc", "linux", "x64", "2.39"),
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(["ok"]);
  });
});
