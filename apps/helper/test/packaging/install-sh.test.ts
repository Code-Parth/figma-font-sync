import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const INSTALL_SH = path.resolve(import.meta.dir, "../../../../packaging/install.sh");
const PINNED_KEY_ID = "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U";
// install.sh is for macOS and Linux; Windows users go through npm.
const POSIX = process.platform !== "win32";

let root: string;
let fakeBin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "font-sync-install-sh-"));
  fakeBin = path.join(root, "fake-bin");
  await mkdir(fakeBin);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function script(file: string, body: string): Promise<void> {
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

/** uname, sysctl and ldd that report a machine of our choosing, first on PATH. */
async function fakeMachine(kernel: string, machine: string, opts: { rosetta?: boolean; musl?: boolean } = {}) {
  await script(path.join(fakeBin, "uname"), `case "$1" in -s) echo ${kernel} ;; -m) echo ${machine} ;; esac`);
  await script(path.join(fakeBin, "sysctl"), `echo ${opts.rosetta ? 1 : 0}`);
  await script(path.join(fakeBin, "ldd"), opts.musl ? "echo 'musl libc (x86_64)' >&2; exit 1" : "echo 'ldd (GNU libc) 2.39'");
}

async function sh(argv: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["sh", ...argv], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...env },
    stdin: "ignore",
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

/** Runs `code` with install.sh's functions loaded and main skipped. */
function withFunctions(code: string, env: Record<string, string> = {}) {
  return sh(["-c", `. "$INSTALL_SH"\n${code}`], { INSTALL_SH, FIGMA_FONT_SYNC_INSTALL_SH_TEST: "1", ...env });
}

describe.skipIf(!POSIX)("install.sh", () => {
  describe("registry document parsing", () => {
    const keyid = PINNED_KEY_ID;
    const meta = JSON.stringify({
      name: "@figma-font-sync/darwin-arm64",
      version: "1.2.3",
      // JSON escapes these quotes, so they must not read as the dist.tarball key.
      description: 'Says "tarball":"https://evil.example/x.tgz" in prose',
      dist: {
        integrity: "sha512-AAAA+/==",
        tarball: "https://registry.npmjs.org/@figma-font-sync/darwin-arm64/-/darwin-arm64-1.2.3.tgz",
        signatures: [
          { keyid: "SHA256:old-key", sig: "OLD+sig/==" },
          { sig: "MEUC+first/==", keyid },
          { keyid, sig: "MEYC+second/==" },
        ],
      },
    }, null, 2);

    it("reads dist.tarball and dist.integrity from pretty or compact JSON", async () => {
      for (const doc of [meta, JSON.stringify(JSON.parse(meta))]) {
        const result = await withFunctions(
          'echo "$(json_string "$META" tarball)"; echo "$(json_string "$META" integrity)"',
          { META: doc },
        );
        expect(result.stdout).toBe(
          "https://registry.npmjs.org/@figma-font-sync/darwin-arm64/-/darwin-arm64-1.2.3.tgz\nsha512-AAAA+/==\n",
        );
      }
    });

    it("keeps only the signatures made with the pinned key", async () => {
      const result = await withFunctions('npm_signatures "$META"', { META: meta });
      expect(result.stdout).toBe("MEUC+first/==\nMEYC+second/==\n");
    });

    it("finds no signature when only other keys signed", async () => {
      const other = JSON.stringify({ dist: { signatures: [{ keyid: "SHA256:old-key", sig: "OLD" }] } });
      const result = await withFunctions('[ -z "$(npm_signatures "$META")" ] && echo none', { META: other });
      expect(result.stdout).toBe("none\n");
    });
  });

  it.each([
    ["1.2.3", true],
    ["0.1.0-beta.1", true],
    ["1.2.3+build.5", true],
    ["", false],
    ["latest", false],
    ["1.2", false],
    ["1.2.3;rm", false],
    ["1.2.3/../x", false],
    ["__VERSION__", false],
  ])("is_version %p is %p", async (version, valid) => {
    const result = await withFunctions('if is_version "$V"; then echo yes; else echo no; fi', { V: version });
    expect(result.stdout).toBe(valid ? "yes\n" : "no\n");
  });

  describe.skipIf(!Bun.which("openssl"))("signature and integrity checks", () => {
    // A key of our own stands in for npm's: same curve, same SPKI and DER encodings.
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const testKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const message = "@figma-font-sync/darwin-arm64@1.2.3:sha512-AAAA";
    const signature = sign("sha256", Buffer.from(message), privateKey).toString("base64");
    const verify = 'NPM_KEY=$TEST_KEY; if verify_signature "$MESSAGE" "$SIG" "$DIR"; then echo valid; else echo invalid; fi';

    it("accepts a signature over <name>@<version>:<integrity>", async () => {
      const result = await withFunctions(verify, { TEST_KEY: testKey, MESSAGE: message, SIG: signature, DIR: root });
      expect(result.stdout).toBe("valid\n");
    });

    it.each([
      ["another version", message.replace("1.2.3", "1.2.4")],
      ["another package", message.replace("darwin-arm64", "darwin-x64")],
      ["another integrity", `${message}B`],
    ])("rejects it for %s", async (_, other) => {
      const result = await withFunctions(verify, { TEST_KEY: testKey, MESSAGE: other, SIG: signature, DIR: root });
      expect(result.stdout).toBe("invalid\n");
    });

    it("rejects a signature npm's pinned key did not make", async () => {
      const result = await withFunctions(
        'if verify_signature "$MESSAGE" "$SIG" "$DIR"; then echo valid; else echo invalid; fi',
        { MESSAGE: message, SIG: signature, DIR: root },
      );
      expect(result.stdout).toBe("invalid\n");
    });

    it("rejects a signature that is not base64 DER", async () => {
      const result = await withFunctions(verify, { TEST_KEY: testKey, MESSAGE: message, SIG: "not a signature", DIR: root });
      expect(result.stdout).toBe("invalid\n");
    });

    it("checks a file against its sha512 integrity", async () => {
      const file = path.join(root, "package.tgz");
      await writeFile(file, "tarball bytes");
      const integrity = `sha512-${createHash("sha512").update("tarball bytes").digest("base64")}`;
      const check = 'if verify_integrity "$FILE" "$INTEGRITY"; then echo match; else echo mismatch; fi';
      expect((await withFunctions(check, { FILE: file, INTEGRITY: integrity })).stdout).toBe("match\n");
      await writeFile(file, "tarball bytez");
      expect((await withFunctions(check, { FILE: file, INTEGRITY: integrity })).stdout).toBe("mismatch\n");
      const sha1 = `sha1-${createHash("sha1").update("tarball bytez").digest("base64")}`;
      expect((await withFunctions(check, { FILE: file, INTEGRITY: sha1 })).stdout).toBe("mismatch\n");
    });
  });

  describe("platform detection", () => {
    const detect = 'detect_platform; echo "$OS-$ARCH"';

    it.each([
      ["Darwin", "arm64", false, "darwin-arm64"],
      ["Darwin", "x86_64", false, "darwin-x64"],
      ["Darwin", "x86_64", true, "darwin-arm64"],
      ["Linux", "x86_64", false, "linux-x64"],
      ["Linux", "amd64", false, "linux-x64"],
    ])("maps %s %s (Rosetta %p) to %s", async (kernel, machine, rosetta, expected) => {
      await fakeMachine(kernel, machine, { rosetta });
      const result = await withFunctions(detect);
      expect(result.stdout).toBe(`${expected}\n`);
    });

    it.each([
      ["MINGW64_NT-10.0", "x86_64", {}, "npm i -g figma-font-sync"],
      ["Linux", "aarch64", {}, "no figma-font-sync build for Linux arm64"],
      ["Linux", "x86_64", { musl: true }, "musl libc"],
      ["FreeBSD", "amd64", {}, "no figma-font-sync build for FreeBSD"],
    ])("refuses %s %s", async (kernel, machine, opts, message) => {
      await fakeMachine(kernel, machine, opts);
      const result = await withFunctions(detect);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    });
  });

  describe("--from", () => {
    let installDir: string;

    beforeEach(async () => {
      installDir = path.join(root, "home", ".local", "bin");
      await fakeMachine("Linux", "x86_64");
    });

    /** An npm pack style tarball: package/package.json and package/bin/figma-font-sync. */
    async function tarball(name: string, output: string): Promise<string> {
      const dir = path.join(root, `pkg-${output}`);
      await mkdir(path.join(dir, "package", "bin"), { recursive: true });
      await writeFile(path.join(dir, "package", "package.json"), JSON.stringify({ name, version: "1.2.3" }, null, 2));
      await script(path.join(dir, "package", "bin", "figma-font-sync"), `echo ${output} "$@"`);
      const file = path.join(root, `${output}.tgz`);
      const tar = Bun.spawnSync(["tar", "-czf", file, "-C", dir, "package"]);
      expect(tar.exitCode).toBe(0);
      return file;
    }

    function install(file: string, env: Record<string, string> = {}) {
      return sh([INSTALL_SH, "--from", file, "--no-setup"], {
        HOME: path.join(root, "home"),
        FIGMA_FONT_SYNC_INSTALL_DIR: installDir,
        ...env,
      });
    }

    it("installs the binary from a local platform tarball", async () => {
      const result = await install(await tarball("@figma-font-sync/linux-x64", "first"));
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const binary = path.join(installDir, "figma-font-sync");
      expect(result.stdout).toContain(`Installed figma-font-sync 1.2.3 to ${binary}`);
      expect((await stat(binary)).mode & 0o777).toBe(0o755);
      expect(Bun.spawnSync([binary, "version"]).stdout.toString()).toBe("first version\n");
    });

    it("replaces an installed binary with a new file", async () => {
      expect((await install(await tarball("@figma-font-sync/linux-x64", "first"))).exitCode).toBe(0);
      const binary = path.join(installDir, "figma-font-sync");
      const before = (await stat(binary)).ino;
      expect((await install(await tarball("@figma-font-sync/linux-x64", "second"))).exitCode).toBe(0);
      expect(await readFile(binary, "utf8")).toContain("echo second");
      expect((await stat(binary)).ino).not.toBe(before);
    });

    it("prints a PATH line for the user's shell only when the directory is not on PATH", async () => {
      const file = await tarball("@figma-font-sync/linux-x64", "first");
      const off = await install(file, { SHELL: "/bin/zsh" });
      expect(off.stdout).toContain(`Add this line to ${path.join(root, "home")}/.zshrc`);
      expect(off.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');
      expect(off.stdout).toContain(`Next: ${path.join(installDir, "figma-font-sync")} setup`);

      const on = await install(file, { PATH: `${installDir}:${fakeBin}:${process.env.PATH}` });
      expect(on.stdout).not.toContain("not on your PATH");
      expect(on.stdout).toContain("Next: figma-font-sync setup");
    });

    it("refuses a tarball built for another platform", async () => {
      const result = await install(await tarball("@figma-font-sync/darwin-arm64", "mac"));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("holds @figma-font-sync/darwin-arm64, but this machine needs @figma-font-sync/linux-x64");
    });

    it("refuses a tarball without the binary", async () => {
      const dir = path.join(root, "empty");
      await mkdir(path.join(dir, "package"), { recursive: true });
      await writeFile(path.join(dir, "package", "package.json"), "{}");
      const file = path.join(root, "empty.tgz");
      Bun.spawnSync(["tar", "-czf", file, "-C", dir, "package"]);
      const result = await install(file);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("has no package/bin/figma-font-sync");
    });
  });

  it("asks for a version when run from the repo, where __VERSION__ is still a placeholder", async () => {
    await fakeMachine("Darwin", "arm64");
    const result = await sh([INSTALL_SH, "--no-setup"], { HOME: path.join(root, "home"), FIGMA_FONT_SYNC_VERSION: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not published with a version");
  });
});
