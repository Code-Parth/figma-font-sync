import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pkg from "../../package.json";

const SCRIPT = path.resolve(import.meta.dir, "../../scripts/pack-npm.ts");
const REPO = path.resolve(import.meta.dir, "../../../..");
const VERSION = pkg.version;
const REPOSITORY = { type: "git", url: "git+https://github.com/Code-Parth/font-sync.git" };

const BINARIES = {
  "darwin-arm64": ["figma-font-sync-darwin-arm64"],
  "darwin-x64": ["figma-font-sync-darwin-x64"],
  "windows-x64": ["figma-font-sync-windows-x64.exe", "figma-font-sync-windows-x64-background.exe"],
  "linux-x64": ["figma-font-sync-linux-x64"],
} as const;
type Suffix = keyof typeof BINARIES;
const ALL = Object.keys(BINARIES) as Suffix[];

let root: string;
let dist: string;
let out: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "font-sync-pack-"));
  dist = path.join(root, "dist");
  out = path.join(root, "out");
  await mkdir(dist);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Each fake binary holds its own file name, so a test can tell which one landed where. */
async function fakeBinaries(files: readonly string[]): Promise<void> {
  for (const file of files) await writeFile(path.join(dist, file), file, { mode: 0o644 });
}

async function pack(...args: string[]) {
  const child = Bun.spawn([process.execPath, SCRIPT, "--dist", dist, "--out", out, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8"));
}

describe("pack-npm.ts", () => {
  it("lays out the main package and every platform package", async () => {
    await fakeBinaries(ALL.flatMap((suffix) => BINARIES[suffix]));
    const result = await pack();
    expect(result.exitCode).toBe(0);
    expect((await readdir(out)).sort()).toEqual(["darwin-arm64", "darwin-x64", "figma-font-sync", "linux-x64", "windows-x64"]);
    for (const dir of await readdir(out)) expect(result.stdout).toContain(path.join(out, dir));

    const main = path.join(out, "figma-font-sync");
    expect(await json(path.join(main, "package.json"))).toEqual({
      name: "figma-font-sync",
      version: VERSION,
      description: expect.any(String),
      keywords: expect.any(Array),
      homepage: "https://www.npmjs.com/package/figma-font-sync",
      repository: REPOSITORY,
      license: "SEE LICENSE IN LICENSE",
      author: "Parth Parmar",
      bin: { "figma-font-sync": "bin/figma-font-sync.js" },
      files: ["bin", "install.sh", "README.md", "LICENSE"],
      engines: { node: ">=18" },
      optionalDependencies: {
        "@figma-font-sync/darwin-arm64": VERSION,
        "@figma-font-sync/darwin-x64": VERSION,
        "@figma-font-sync/windows-x64": VERSION,
        "@figma-font-sync/linux-x64": VERSION,
      },
    });
    expect(await readFile(path.join(main, "bin", "figma-font-sync.js"), "utf8")).toBe(
      await readFile(path.join(REPO, "packaging/npm/bin/figma-font-sync.js"), "utf8"),
    );
    expect(await readFile(path.join(main, "README.md"), "utf8")).toBe(await readFile(path.join(REPO, "README.md"), "utf8"));

    const installSh = await readFile(path.join(main, "install.sh"), "utf8");
    expect(installSh).toContain(`PUBLISHED_VERSION='${VERSION}'`);
    expect(installSh).not.toContain("__VERSION__");
  });

  it.each([
    ["darwin-arm64", "darwin", "arm64"],
    ["darwin-x64", "darwin", "x64"],
    ["windows-x64", "win32", "x64"],
    ["linux-x64", "linux", "x64"],
  ] as const)("writes @figma-font-sync/%s for os %s and cpu %s", async (suffix, os, cpu) => {
    await fakeBinaries(ALL.flatMap((s) => BINARIES[s]));
    expect((await pack()).exitCode).toBe(0);
    const dir = path.join(out, suffix);
    expect(await json(path.join(dir, "package.json"))).toEqual({
      name: `@figma-font-sync/${suffix}`,
      version: VERSION,
      description: expect.any(String),
      repository: REPOSITORY,
      license: "SEE LICENSE IN LICENSE",
      author: "Parth Parmar",
      os: [os],
      cpu: [cpu],
      ...(os === "linux" ? { libc: ["glibc"] } : {}),
      preferUnplugged: true,
      files: ["bin"],
      publishConfig: { access: "public" },
    });
    expect(await readdir(dir)).toContain("README.md");
  });

  it("names the binaries for the launcher and makes them executable", async () => {
    await fakeBinaries(ALL.flatMap((suffix) => BINARIES[suffix]));
    expect((await pack()).exitCode).toBe(0);
    const expected: Record<Suffix, Record<string, string>> = {
      "darwin-arm64": { "figma-font-sync": "figma-font-sync-darwin-arm64" },
      "darwin-x64": { "figma-font-sync": "figma-font-sync-darwin-x64" },
      "windows-x64": {
        "figma-font-sync.exe": "figma-font-sync-windows-x64.exe",
        "figma-font-sync-background.exe": "figma-font-sync-windows-x64-background.exe",
      },
      "linux-x64": { "figma-font-sync": "figma-font-sync-linux-x64" },
    };
    for (const suffix of ALL) {
      const bin = path.join(out, suffix, "bin");
      expect((await readdir(bin)).sort()).toEqual(Object.keys(expected[suffix]).sort());
      for (const [name, source] of Object.entries(expected[suffix])) {
        expect(await readFile(path.join(bin, name), "utf8")).toBe(source);
        // Windows has no exec bit to check.
        if (process.platform !== "win32") expect((await stat(path.join(bin, name))).mode & 0o777).toBe(0o755);
      }
    }
  });

  it("fails when a platform is missing", async () => {
    await fakeBinaries(BINARIES["darwin-arm64"]);
    const result = await pack();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("figma-font-sync-darwin-x64");
    expect(result.stderr).toContain("figma-font-sync-linux-x64");
    expect(result.stderr).toContain("--partial");
    expect(await readdir(root)).not.toContain("out");
  });

  it("with --partial, packs and depends on only the platforms that were built", async () => {
    await fakeBinaries(BINARIES["darwin-arm64"]);
    // Left over from an earlier full run; publishing it would ship stale binaries.
    await mkdir(path.join(out, "linux-x64", "bin"), { recursive: true });
    const result = await pack("--partial");
    expect(result.exitCode).toBe(0);
    expect((await readdir(out)).sort()).toEqual(["darwin-arm64", "figma-font-sync"]);
    const main = await json(path.join(out, "figma-font-sync", "package.json"));
    expect(main.optionalDependencies).toEqual({ "@figma-font-sync/darwin-arm64": VERSION });
  });

  it("fails without any binary, even with --partial", async () => {
    const result = await pack("--partial");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no binaries");
  });

  it.each([
    ["client ID", "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com"],
    ["client secret", "GOCSPX-abcdefghijklmnopqrstuvwxyz12"],
  ])("refuses a binary with a Google %s baked in, even with --partial", async (_, value) => {
    await fakeBinaries(BINARIES["darwin-arm64"]);
    // Bytes that are not valid UTF-8 around the string, as in a real binary.
    const binary = Buffer.concat([Buffer.from([0, 0xc3, 0xff]), Buffer.from(value), Buffer.from([0xfe, 0])]);
    await writeFile(path.join(dist, "figma-font-sync-darwin-arm64"), binary);
    const result = await pack("--partial");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("figma-font-sync-darwin-arm64");
    expect(result.stderr).toContain("FONT_SYNC_PUBLIC_BUILD=1 bun --no-env-file");
    expect(result.stderr).not.toContain(value);
    expect(await readdir(root)).not.toContain("out");
  });

  it("names every binary with a client, across platforms", async () => {
    await fakeBinaries(ALL.flatMap((suffix) => BINARIES[suffix]));
    const secret = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";
    await writeFile(path.join(dist, "figma-font-sync-linux-x64"), secret);
    await writeFile(path.join(dist, "figma-font-sync-windows-x64-background.exe"), secret);
    const result = await pack();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("figma-font-sync-windows-x64-background.exe, figma-font-sync-linux-x64");
    expect(result.stderr).not.toContain("figma-font-sync-darwin-arm64");
  });

  it("packs a binary holding only the example client ID that setup prints", async () => {
    await fakeBinaries(BINARIES["darwin-arm64"]);
    // apps/helper/src/config/google-client.ts shows this in its error message, so every public binary has it.
    await writeFile(path.join(dist, "figma-font-sync-darwin-arm64"), "123456789012-abc123def456.apps.googleusercontent.com");
    expect((await pack("--partial")).exitCode).toBe(0);
  });

  it("the root pack:npm script builds without a Google client", async () => {
    const { scripts } = (await json(path.join(REPO, "package.json"))) as { scripts: Record<string, string> };
    // `bun run build` reaches apps/helper, where Bun loads apps/helper/.env into build.ts.
    expect(scripts["pack:npm"]).toContain("FONT_SYNC_PUBLIC_BUILD=1 bun --no-env-file apps/helper/scripts/build.ts &&");
    expect(scripts["pack:npm"]).not.toContain("bun run build");
  });

  it("refuses a Windows package without its background exe, even with --partial", async () => {
    await fakeBinaries(["figma-font-sync-windows-x64.exe"]);
    const result = await pack("--partial");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("@figma-font-sync/windows-x64 is incomplete");
    expect(result.stderr).toContain("figma-font-sync-windows-x64-background.exe");
  });
});
