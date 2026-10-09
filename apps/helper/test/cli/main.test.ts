import { describe, expect, it, spyOn } from "bun:test";
import { MAX_REQUEST_BYTES } from "../../src/api/app";
import type { Helper } from "../../src/helper";
import type { LibraryFile } from "../../src/library/library";
import {
  autostartCommand,
  type CliDeps,
  type Command,
  main,
  parseCommand,
  parseFolderId,
  parsePort,
  UsageError,
} from "../../src/main";
import type { Autostart } from "../../src/service/autostart";
import { fakeHelper } from "../api/support";

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
  ];
  it.each(invalid.map((argv) => [argv.join(" "), argv] as const))("rejects %s", (_label, argv) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
  });
});

describe("autostartCommand", () => {
  it("runs a compiled binary directly", () => {
    expect(autostartCommand("/$bunfs/root/font-sync", "/usr/local/bin/font-sync")).toEqual([
      "/usr/local/bin/font-sync",
      "serve",
    ]);
  });

  it("starts the console-less copy next to a compiled Windows binary", () => {
    expect(autostartCommand("B:/~BUN/root/font-sync.exe", "C:\\Tools\\font-sync.exe")).toEqual([
      "C:\\Tools\\font-sync-background.exe",
      "serve",
    ]);
  });

  it("passes the script to bun otherwise", () => {
    expect(autostartCommand("/repo/apps/helper/src/main.ts", "/opt/bun/bin/bun")).toEqual([
      "/opt/bun/bin/bun",
      "/repo/apps/helper/src/main.ts",
      "serve",
    ]);
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

function cli(overrides: Partial<Helper> = {}, autostart: Partial<Autostart> = {}) {
  const fake = fakeHelper(overrides);
  const out: string[] = [];
  const err: string[] = [];
  const enabled: { command: string[]; env: Record<string, string> | undefined }[] = [];
  const deps: CliDeps = {
    platform: "darwin",
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    helper: async () => fake.helper,
    autostart: () => ({
      enable: async (command, env) => {
        enabled.push({ command, env });
      },
      disable: async () => {},
      status: async () => ({ enabled: false, detail: "not registered" }),
      ...autostart,
    }),
    main: "/$bunfs/root/font-sync",
    execPath: "/Applications/font-sync",
  };
  return { ...fake, deps, out, err, enabled };
}

describe("main", () => {
  it("exits 2 on bad usage", async () => {
    const { deps, err } = cli();
    expect(await main(["frobnicate"], deps)).toBe(2);
    expect(err[0]).toContain("Unknown command: frobnicate");
  });

  it("lists what sync would install without installing", async () => {
    const { deps, out, calls } = cli({
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
    expect(calls.installs).toEqual([]);
    expect(out).toEqual([
      "skip     D.ttf: not a font",
      "install  Brand/B.otf",
      "update   C.ttf",
      "2 files would be installed.",
    ]);
  });

  it("installs missing files and fails when one does not install", async () => {
    const { deps, err, calls } = cli({
      files: async () => ({
        syncedAt: "2026-10-07T12:00:00.000Z",
        files: [libraryFile({ id: "a", name: "A.ttf" }), libraryFile({ id: "b", name: "B.ttf" })],
      }),
      install: async (fileIds) => {
        calls.installs.push(fileIds);
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
    expect(calls.installs).toEqual([["a", "b"]]);
    expect(err).toEqual(["failed   B.ttf: disk full"]);
  });

  it("registers the compiled binary for autostart", async () => {
    const { deps, enabled, err } = cli();
    expect(await main(["autostart", "enable"], deps)).toBe(0);
    expect(enabled).toEqual([{ command: ["/Applications/font-sync", "serve"], env: {} }]);
    expect(err).toEqual([]);
  });

  it("passes the shell's Google client to start-at-login, which does not inherit the shell", async () => {
    const { deps, enabled, err } = cli();
    deps.env = {
      FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client",
      FONT_SYNC_GOOGLE_CLIENT_SECRET: "dev-secret",
      FONT_SYNC_PORT: "47322",
    };
    expect(await main(["autostart", "enable"], deps)).toBe(0);
    expect(enabled[0]?.env).toEqual({ FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client", FONT_SYNC_GOOGLE_CLIENT_SECRET: "dev-secret" });
    expect(err.join("\n")).toContain("will use FONT_SYNC_GOOGLE_CLIENT_ID and FONT_SYNC_GOOGLE_CLIENT_SECRET from this shell");

    const idOnly = cli();
    idOnly.deps.env = { FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client" };
    await main(["autostart", "enable"], idOnly.deps);
    expect(idOnly.enabled[0]?.env).toEqual({ FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client" });
  });

  it("tells Windows users to set the client themselves, since the Run key carries no environment", async () => {
    const { deps, err } = cli();
    deps.platform = "win32";
    deps.env = { FONT_SYNC_GOOGLE_CLIENT_ID: "dev-client" };
    expect(await main(["autostart", "enable"], deps)).toBe(0);
    expect(err.join("\n")).toContain("setx");
  });

  it("serves on both loopback addresses with no idle timeout and no Bun body limit", async () => {
    const listened: { hostname?: unknown; port?: unknown; idleTimeout?: unknown; maxRequestBodySize?: unknown }[] = [];
    const serve = spyOn(Bun, "serve").mockImplementation(((options: (typeof listened)[number]) => {
      listened.push(options);
      return { stop: () => {} };
    }) as unknown as typeof Bun.serve);
    const signalListeners = process.listenerCount("SIGTERM");
    try {
      const { deps } = cli();
      deps.env = { FONT_SYNC_PORT: "47399" };
      const running = main(["serve"], deps);
      while (process.listenerCount("SIGTERM") === signalListeners) await Bun.sleep(1);
      // Both, so neither once-listener outlives the test.
      process.emit("SIGTERM");
      process.emit("SIGINT");
      expect(await running).toBe(0);
    } finally {
      serve.mockRestore();
    }
    expect(listened.map(({ hostname, port, idleTimeout }) => ({ hostname, port, idleTimeout }))).toEqual([
      { hostname: "127.0.0.1", port: 47399, idleTimeout: 0 },
      { hostname: "::1", port: 47399, idleTimeout: 0 },
    ]);
    for (const { maxRequestBodySize } of listened) expect(maxRequestBodySize).toBeGreaterThan(MAX_REQUEST_BYTES);
  });

  it("does not offer to create a library when Drive's folder search was partial", async () => {
    const { deps, out, err } = cli({ candidates: async () => ({ folders: [], incomplete: true }) });
    expect(await main(["library", "list"], deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "font-sync: Google Drive answered with a partial search and found no font-sync-figma-plugin folder. Try again in a minute.",
    ]);
  });

  it("reports a helper failure with exit code 1", async () => {
    const { deps, err } = cli({
      candidates: async () => {
        throw new Error("Google Drive is unreachable");
      },
    });
    expect(await main(["library", "list"], deps)).toBe(1);
    expect(err).toEqual(["font-sync: Google Drive is unreachable"]);
  });

  it("prints status even when the autostart check fails", async () => {
    const { deps, out } = cli(
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

  it("revokes every pairing", async () => {
    const { deps, out, pairing, clock } = cli();
    await pairing.complete(pairing.start("A").code, "A");
    clock.advance(10_000);
    await pairing.complete(pairing.start("B").code, "B");
    expect(await main(["pairs", "revoke-all"], deps)).toBe(0);
    expect(out).toEqual(["Revoked 2 pairings. Plugins have to pair again."]);
    expect(await pairing.clients()).toEqual([]);
  });
});
