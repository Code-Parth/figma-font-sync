import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_REQUEST_BYTES } from "../../src/api/app";
import { pidFilePath, readPidFile, writePidFile } from "../../src/cli/daemon";
import type { Helper } from "../../src/helper";
import type { LibraryFile } from "../../src/library/library";
import { type Command, main, parseCommand, parseFolderId, parsePort, UsageError } from "../../src/main";
import type { Autostart } from "../../src/service/autostart";
import { VERSION } from "../../src/version";
import { SIGNED_IN } from "../api/support";
import { type Cli, CLIENT_ID, makeCli, TEST_PORT } from "./cli-support";

const SIGNED_OUT = { ...SIGNED_IN, auth: "signed-out" as const, account: null, library: null };

const ID = "1AbC-dEf_GhIjKlMnOpQrStUvWxYz0123";

describe("parseFolderId", () => {
  it.each([
    [ID, ID],
    [`  ${ID}  `, ID],
    [`https://drive.google.com/drive/folders/${ID}`, ID],
    [`https://drive.google.com/drive/folders/${ID}?usp=sharing`, ID],
    [`https://drive.google.com/drive/u/1/folders/${ID}`, ID],
    [`https://drive.google.com/drive/mobile/folders/${ID}?usp=drive_link`, ID],
    [`https://drive.google.com/open?id=${ID}`, ID],
    [`https://drive.google.com/folderview?id=${ID}&usp=sharing`, ID],
  ])("reads %s", (input, expected) => {
    expect(parseFolderId(input)).toBe(expected);
  });

  it.each([
    "",
    "short",
    "has spaces in it ok",
    `https://evil.example/drive/folders/${ID}`,
    `https://drive.google.com.evil.example/drive/folders/${ID}`,
    `ftp://drive.google.com/drive/folders/${ID}`,
    "https://drive.google.com/drive/my-drive",
    "https://drive.google.com/drive/folders/../../x",
    `javascript:alert("${ID}")`,
  ])("rejects %s", (input) => {
    expect(parseFolderId(input)).toBeNull();
  });
});

describe("parseCommand", () => {
  it.each<[string[], Command]>([
    [[], { name: "serve" }],
    [["serve"], { name: "serve" }],
    [["login"], { name: "login" }],
    [["logout"], { name: "logout" }],
    [["status"], { name: "status" }],
    [["version"], { name: "version" }],
    [["--version"], { name: "version" }],
    [["-v"], { name: "version" }],
    [["help"], { name: "help" }],
    [["--help"], { name: "help" }],
    [["-h"], { name: "help" }],
    [["library", "list"], { name: "library", action: "list" }],
    [["library", "create"], { name: "library", action: "create" }],
    [["library", "use", ID], { name: "library", action: "use", folderId: ID }],
    [["library", "use", `https://drive.google.com/drive/folders/${ID}`], { name: "library", action: "use", folderId: ID }],
    [["sync"], { name: "sync", dryRun: false }],
    [["sync", "--dry-run"], { name: "sync", dryRun: true }],
    [["autostart", "enable"], { name: "autostart", action: "enable" }],
    [["autostart", "disable"], { name: "autostart", action: "disable" }],
    [["autostart", "status"], { name: "autostart", action: "status" }],
    [["pairs", "list"], { name: "pairs", action: "list" }],
    [["pairs", "revoke-all"], { name: "pairs", action: "revoke-all" }],
    [["start"], { name: "start" }],
    [["stop"], { name: "stop" }],
    [["restart"], { name: "restart" }],
    [["plugin"], { name: "plugin" }],
    [["doctor"], { name: "doctor" }],
    [["setup"], { name: "setup", clientId: null, clientSecret: null, autostart: true, login: true, yes: false }],
    [
      ["setup", "--client-id", CLIENT_ID, "--client-secret", "GOCSPX-abc", "--no-autostart", "--no-login", "--yes"],
      { name: "setup", clientId: CLIENT_ID, clientSecret: "GOCSPX-abc", autostart: false, login: false, yes: true },
    ],
    [
      ["setup", `--client-id=${CLIENT_ID}`, "--client-secret="],
      { name: "setup", clientId: CLIENT_ID, clientSecret: "", autostart: true, login: true, yes: false },
    ],
    [["uninstall"], { name: "uninstall", purge: false, yes: false }],
    [["uninstall", "--purge", "--yes"], { name: "uninstall", purge: true, yes: true }],
  ])("parses %p", (argv, expected) => {
    expect(parseCommand(argv)).toEqual(expected);
  });

  const invalid: string[][] = [
    ["bogus"],
    ["status", "extra"],
    ["library"],
    ["library", "use"],
    ["library", "use", "not a folder"],
    ["library", "use", ID, "extra"],
    ["library", "delete"],
    ["sync", "--force"],
    ["autostart"],
    ["autostart", "restart"],
    ["pairs", "revoke"],
    ["start", "now"],
    ["stop", "--force"],
    ["restart", "now"],
    ["plugin", "install"],
    ["doctor", "--fix"],
    ["setup", "--client-id"],
    ["setup", "--client-id", "--yes"],
    ["setup", "--client-secret", "GOCSPX-abc"],
    ["setup", "--yes", "--yes"],
    ["setup", "--no-login=1"],
    ["setup", "--frobnicate"],
    ["setup", "extra"],
    ["uninstall", "--force"],
    ["uninstall", "everything"],
    ["uninstall", "-y"],
    ["setup", "-y"],
  ];
  it.each(invalid.map((argv) => [argv.join(" "), argv] as const))("rejects %s", (_label, argv) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
  });
});

describe("parsePort", () => {
  it("defaults to 47321 and accepts a valid port", () => {
    expect(parsePort(undefined)).toBe(47321);
    expect(parsePort("")).toBe(47321);
    expect(parsePort("8080")).toBe(8080);
  });

  it.each(["0", "65536", "80.5", "http", "-1"])("rejects %s", (value) => {
    expect(() => parsePort(value)).toThrow("FONT_SYNC_PORT");
  });
});

function libraryFile(overrides: Partial<LibraryFile>): LibraryFile {
  return {
    id: "file",
    name: "Font.ttf",
    path: "",
    size: 10,
    md5: "0123456789abcdef0123456789abcdef",
    modifiedTime: "2026-10-01T00:00:00.000Z",
    uploadedBy: null,
    faces: [],
    parseError: null,
    install: "not-installed",
    canRemove: false,
    ...overrides,
  };
}

const made: Cli[] = [];

afterEach(async () => {
  for (const each of made.splice(0)) await each.cleanup();
});

async function cli(helper: Partial<Helper> = {}, autostart: Partial<Autostart> = {}): Promise<Cli> {
  const created = await makeCli({ helper, autostart });
  made.push(created);
  return created;
}

/** A file standing in for the compiled binary that installRuntime copies. */
async function fakeBinary(each: Cli): Promise<string> {
  const binary = path.join(each.root, "npm", "node_modules", "@figma-font-sync", "darwin-arm64", "bin", "figma-font-sync");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "binary");
  each.deps.standalone = true;
  each.deps.execPath = binary;
  each.deps.main = "/$bunfs/root/figma-font-sync";
  return binary;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Runs `serve` with Bun.serve faked until it registers its signal handlers, then stops it with SIGTERM. */
async function serveUntilStopped(each: Cli, whileRunning: () => Promise<void> = async () => {}) {
  const listened: { hostname?: unknown; port?: unknown; idleTimeout?: unknown; maxRequestBodySize?: unknown }[] = [];
  const serve = spyOn(Bun, "serve").mockImplementation(((options: (typeof listened)[number]) => {
    listened.push(options);
    return { stop: () => {} };
  }) as unknown as typeof Bun.serve);
  const signalListeners = process.listenerCount("SIGTERM");
  try {
    const running = main(["serve"], each.deps);
    while (process.listenerCount("SIGTERM") === signalListeners) await Bun.sleep(1);
    await whileRunning();
    // Both, so neither once-listener outlives the test.
    process.emit("SIGTERM");
    process.emit("SIGINT");
    return { code: await running, listened };
  } finally {
    serve.mockRestore();
  }
}

describe("main", () => {
  it("exits 2 on bad usage", async () => {
    const { deps, err } = await cli();
    expect(await main(["frobnicate"], deps)).toBe(2);
    expect(err).toEqual([
      "figma-font-sync: Unknown command: frobnicate",
      'Run "figma-font-sync help" for the list of commands.',
    ]);
  });

  it("names the command figma-font-sync in its help", async () => {
    const { deps, out } = await cli();
    expect(await main(["help"], deps)).toBe(0);
    expect(out.join("\n")).toContain("Usage: figma-font-sync [command]");
    for (const command of ["setup", "doctor", "plugin", "start", "stop", "restart", "uninstall", "--no-autostart"]) {
      expect(out.join("\n")).toContain(command);
    }
  });

  it("lists what sync would install without installing", async () => {
    const { deps, out, fake } = await cli({
      files: async () => ({
        syncedAt: "2026-10-07T12:00:00.000Z",
        files: [
          libraryFile({ id: "a", name: "A.ttf", install: "installed" }),
          libraryFile({ id: "b", name: "B.otf", path: "Brand", install: "not-installed" }),
          libraryFile({ id: "c", name: "C.ttf", install: "outdated" }),
          libraryFile({ id: "d", name: "D.ttf", parseError: "not a font" }),
          libraryFile({ id: "e", name: "E.ttf", install: "not-in-library" }),
        ],
      }),
    });
    expect(await main(["sync", "--dry-run"], deps)).toBe(0);
    expect(fake.calls.installs).toEqual([]);
    expect(out).toEqual([
      "skip     D.ttf: not a font",
      "install  Brand/B.otf",
      "update   C.ttf",
      "2 files would be installed.",
    ]);
  });

  it("installs missing files and fails when one does not install", async () => {
    const installs: string[][] = [];
    const { deps, err } = await cli({
      files: async () => ({
        syncedAt: "2026-10-07T12:00:00.000Z",
        files: [libraryFile({ id: "a", name: "A.ttf" }), libraryFile({ id: "b", name: "B.ttf" })],
      }),
      install: async (fileIds) => {
        installs.push(fileIds);
        return {
          results: [
            { fileId: "a", ok: true, error: null },
            { fileId: "b", ok: false, error: "disk full" },
          ],
          reloadRequired: true,
        };
      },
    });
    expect(await main(["sync"], deps)).toBe(1);
    expect(installs).toEqual([["a", "b"]]);
    expect(err).toEqual(["failed   B.ttf: disk full"]);
  });

  it("registers the versioned runtime copy for autostart, never the binary npm installed", async () => {
    const each = await cli();
    const binary = await fakeBinary(each);
    expect(await main(["autostart", "enable"], each.deps)).toBe(0);
    const copy = path.join(each.paths.dataDir, "bin", `figma-font-sync-${VERSION}`);
    expect(each.calls.enabled).toEqual([{ command: [copy, "serve"], env: {} }]);
    expect(await readFile(copy, "utf8")).toBe(await readFile(binary, "utf8"));
    expect(each.err).toEqual([]);
  });

  it("registers bun and the script when running from source", async () => {
    const { deps, calls } = await cli();
    expect(await main(["autostart", "enable"], deps)).toBe(0);
    expect(calls.enabled[0]?.command).toEqual(["/opt/bun/bin/bun", "/repo/apps/helper/src/main.ts", "serve"]);
  });

  it("stops a helper that start spawned before launchd starts the registered one, except on Windows", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const order: string[] = [];
      const each = await cli({}, { enable: async () => void order.push("enable") });
      each.deps.platform = platform;
      each.deps.kill = (pid, signal) => {
        order.push(`kill ${pid} ${signal}`);
        each.helperProcess.running = false;
      };
      each.helperProcess.running = true;
      await writePidFile(each.paths, { pid: 4242, port: Number(TEST_PORT), version: VERSION, startedAt: "2026-01-01T00:00:00.000Z" });
      expect(await main(["autostart", "enable"], each.deps)).toBe(0);
      // The Run key starts nothing until the next login, so there is nothing to collide with.
      expect(order).toEqual(platform === "win32" ? ["enable"] : ["kill 4242 SIGTERM", "enable"]);
    }
  });

  it("passes the shell's Google client to start-at-login, which does not inherit the shell", async () => {
    const { deps, calls, err } = await cli();
    deps.env = {
      FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client",
      FONT_SYNC_GOOGLE_CLIENT_SECRET: "dev-secret",
      FONT_SYNC_PORT: "47322",
    };
    expect(await main(["autostart", "enable"], deps)).toBe(0);
    expect(calls.enabled[0]?.env).toEqual({ FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client", FONT_SYNC_GOOGLE_CLIENT_SECRET: "dev-secret" });
    expect(err.join("\n")).toContain("will use FONT_SYNC_GOOGLE_CLIENT_ID and FONT_SYNC_GOOGLE_CLIENT_SECRET from this shell");

    const idOnly = await cli();
    idOnly.deps.env = { FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client" };
    await main(["autostart", "enable"], idOnly.deps);
    expect(idOnly.calls.enabled[0]?.env).toEqual({ FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client" });
  });

  it("tells Windows users to save the client with setup, since the Run key carries no environment", async () => {
    const { deps, err } = await cli();
    deps.platform = "win32";
    deps.env = { FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client" };
    expect(await main(["autostart", "enable"], deps)).toBe(0);
    expect(err.join("\n")).toContain('"figma-font-sync setup --client-id <id> --client-secret <secret>"');
  });

  it("serves on both loopback addresses with no idle timeout and no Bun body limit", async () => {
    const each = await cli();
    each.deps.env = { FONT_SYNC_PORT: "47399" };
    const { code, listened } = await serveUntilStopped(each);
    expect(code).toBe(0);
    expect(listened.map(({ hostname, port, idleTimeout }) => ({ hostname, port, idleTimeout }))).toEqual([
      { hostname: "127.0.0.1", port: 47399, idleTimeout: 0 },
      { hostname: "::1", port: 47399, idleTimeout: 0 },
    ]);
    for (const { maxRequestBodySize } of listened) expect(maxRequestBodySize).toBeGreaterThan(MAX_REQUEST_BYTES);
  });

  it("writes helper.pid while serving and removes it when stopped", async () => {
    const each = await cli();
    each.deps.env = { FONT_SYNC_PORT: "47399" };
    let whileRunning: unknown = null;
    const { code } = await serveUntilStopped(each, async () => {
      whileRunning = await readPidFile(each.paths);
    });
    expect(code).toBe(0);
    expect(whileRunning).toEqual({ pid: process.pid, port: 47399, version: VERSION, startedAt: expect.any(String) });
    expect(await exists(pidFilePath(each.paths))).toBe(false);
  });

  it("refreshes the plugin files before serving, and only warns when it cannot", async () => {
    const each = await cli();
    await serveUntilStopped(each);
    const manifest = path.join(each.paths.dataDir, "figma-plugin", "manifest.json");
    expect(await exists(manifest)).toBe(true);

    const broken = await cli();
    broken.deps.pluginSource = () => path.join(broken.root, "nowhere");
    const { code } = await serveUntilStopped(broken);
    expect(code).toBe(0);
    expect(broken.err.join("\n")).toContain("figma-font-sync: could not update the Figma plugin files:");
  });

  it("tells a server without a Google client to run setup", async () => {
    const each = await cli({ status: async () => ({ ...SIGNED_OUT, auth: "not-configured" }) });
    await serveUntilStopped(each);
    expect(each.err).toContain('figma-font-sync: Google sign-in is not configured. Run "figma-font-sync setup".');
  });

  it("starts the helper in the background once and then leaves it alone", async () => {
    const { deps, out, calls, paths } = await cli();
    expect(await main(["start"], deps)).toBe(0);
    expect(calls.spawned).toEqual([
      { argv: ["/opt/bun/bin/bun", "/repo/apps/helper/src/main.ts", "serve"], logFile: path.join(paths.stateDir, "font-sync.log") },
    ]);
    expect(out).toEqual([
      `Started the Font Sync helper ${VERSION} on http://localhost:47398 in the background.`,
      `Log: ${path.join(paths.stateDir, "font-sync.log")}`,
    ]);
    expect(await exists(path.join(paths.dataDir, "figma-plugin", "manifest.json"))).toBe(true);

    out.length = 0;
    expect(await main(["start"], deps)).toBe(0);
    expect(calls.spawned).toHaveLength(1);
    expect(out).toEqual([`The Font Sync helper ${VERSION} is already running on http://localhost:47398.`]);
  });

  it("starts and stops through the service manager when start at login is registered", async () => {
    const { deps, out, calls, service, home } = await cli();
    service.registered = true;
    expect(await main(["start"], deps)).toBe(0);
    expect(calls.serviceStarts).toBe(1);
    expect(calls.spawned).toEqual([]);
    // From source the registration is left alone: it may name an installed binary.
    expect(calls.enabled).toEqual([]);
    expect(out).toEqual([
      `Started the Font Sync helper ${VERSION} on http://localhost:47398 through launchd.`,
      `Log: ${path.join(home, "Library", "Logs", "font-sync.log")}`,
    ]);

    out.length = 0;
    expect(await main(["stop"], deps)).toBe(0);
    expect(calls.serviceStops).toBe(1);
    expect(out[0]).toBe("Stopped the Font Sync helper.");
    expect(out[1]).toContain("starts again at next login");
  });

  it("points start at login at this version's copy before starting, unless this version already runs", async () => {
    const each = await cli();
    const { deps, calls, service, paths, root } = each;
    const binary = path.join(root, "figma-font-sync");
    await writeFile(binary, "binary");
    deps.standalone = true;
    deps.execPath = binary;
    service.registered = true;
    expect(await main(["start"], deps)).toBe(0);
    const copy = path.join(paths.dataDir, "bin", `figma-font-sync-${VERSION}`);
    expect(calls.enabled).toEqual([{ command: [copy, "serve"], env: {} }]);
    expect(calls.serviceStarts).toBe(1);

    expect(await main(["start"], deps)).toBe(0);
    expect(calls.enabled).toHaveLength(1);
  });

  it("still starts the helper when launchd refuses the LaunchAgent, and says how to fix it", async () => {
    const refused = new Error("launchctl bootstrap failed: Bootstrap failed: 5: Input/output error");
    const each = await cli(
      {},
      {
        isRegistered: async () => true,
        enable: async () => {
          throw refused;
        },
        startService: async () => {
          throw refused;
        },
      },
    );
    const binary = path.join(each.root, "figma-font-sync");
    await writeFile(binary, "binary");
    each.deps.standalone = true;
    each.deps.execPath = binary;
    expect(await main(["start"], each.deps)).toBe(0);
    expect(each.calls.spawned).toHaveLength(1);
    expect(each.out[0]).toBe(`Started the Font Sync helper ${VERSION} on http://localhost:47398 in the background.`);
    expect(each.err).toEqual([
      `figma-font-sync: could not point start at login at this version: ${refused.message}`,
      expect.stringContaining("System Settings > General > Login Items"),
    ]);
  });

  it("says so when there is nothing to stop", async () => {
    const { deps, out } = await cli();
    expect(await main(["stop"], deps)).toBe(0);
    expect(out).toEqual(["The Font Sync helper is not running."]);
  });

  it("restarts by stopping first, without the next-login note", async () => {
    const { deps, out, calls, service, helperProcess } = await cli();
    service.registered = true;
    helperProcess.running = true;
    expect(await main(["restart"], deps)).toBe(0);
    expect(calls.serviceStops).toBe(1);
    expect(calls.serviceStarts).toBe(1);
    expect(out[0]).toBe("Stopped the Font Sync helper.");
    expect(out.join("\n")).not.toContain("next login");
    expect(out[1]).toStartWith(`Started the Font Sync helper ${VERSION}`);
  });

  it("writes the plugin files and prints how to import them", async () => {
    const { deps, out, paths } = await cli();
    expect(await main(["plugin"], deps)).toBe(0);
    const manifest = path.join(paths.dataDir, "figma-plugin", "manifest.json");
    expect(await exists(manifest)).toBe(true);
    expect(out.join("\n")).toContain(manifest);
  });

  it("fails the plugin command when the plugin source is missing", async () => {
    const { deps, err, root } = await cli();
    deps.pluginSource = () => path.join(root, "nowhere");
    expect(await main(["plugin"], deps)).toBe(1);
    expect(err[0]).toStartWith("figma-font-sync: ");
  });

  it("does not offer to create a library when Drive's folder search was partial", async () => {
    const { deps, out, err } = await cli({ candidates: async () => ({ folders: [], incomplete: true }) });
    expect(await main(["library", "list"], deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "figma-font-sync: Google Drive answered with a partial search and found no font-sync-figma-plugin folder. Try again in a minute.",
    ]);
  });

  it("reports a helper failure with exit code 1", async () => {
    const { deps, err } = await cli({
      candidates: async () => {
        throw new Error("Google Drive is unreachable");
      },
    });
    expect(await main(["library", "list"], deps)).toBe(1);
    expect(err).toEqual(["figma-font-sync: Google Drive is unreachable"]);
  });

  it("prints status even when the autostart check fails", async () => {
    const { deps, out } = await cli(
      {},
      {
        status: async () => {
          throw new Error("launchctl not found");
        },
      },
    );
    expect(await main(["status"], deps)).toBe(0);
    expect(out).toEqual([
      "Font Sync helper 0.0.0-test on darwin",
      "Google:     signed in as ada@example.com",
      "Library:    font-sync-figma-plugin (editor, owned by owner@example.com, can upload)",
      "            https://drive.google.com/drive/folders/folder123456",
      "Autostart:  off (could not check: launchctl not found)",
      "Paired:     0 plugins",
    ]);
  });

  it("points an unconfigured status at setup", async () => {
    const { deps, out } = await cli({ status: async () => ({ ...SIGNED_OUT, auth: "not-configured" }) });
    expect(await main(["status"], deps)).toBe(0);
    expect(out).toContain('Google:     not configured (run "figma-font-sync setup")');
  });

  it("revokes every pairing", async () => {
    const { deps, out, fake } = await cli();
    const { pairing, clock } = fake;
    await pairing.complete(pairing.start("A").code, "A");
    clock.advance(10_000);
    await pairing.complete(pairing.start("B").code, "B");
    expect(await main(["pairs", "revoke-all"], deps)).toBe(0);
    expect(out).toEqual(["Revoked 2 pairings. Plugins have to pair again."]);
    expect(await pairing.clients()).toEqual([]);
  });
});
