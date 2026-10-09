import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCheck } from "../../src/cli/doctor";
import { figmaDesktopCandidates, findFigmaDesktop } from "../../src/cli/figma-desktop";
import type { Status } from "../../src/helper";
import { main } from "../../src/main";
import { VERSION } from "../../src/version";
import { SIGNED_IN } from "../api/support";
import { type Cli, CLIENT_ID, makeCli } from "./cli-support";

const made: Cli[] = [];

afterEach(async () => {
  for (const each of made.splice(0)) await each.cleanup();
});

async function cli(opts: Parameters<typeof makeCli>[0] = {}): Promise<Cli> {
  const created = await makeCli(opts);
  made.push(created);
  return created;
}

async function storeClient(each: Cli): Promise<void> {
  await mkdir(each.paths.configDir, { recursive: true });
  await writeFile(
    path.join(each.paths.configDir, "config.json"),
    JSON.stringify({ libraryFolderId: null, pairedClients: [], googleClient: { clientId: CLIENT_ID, clientSecret: null } }),
  );
}

/** Everything doctor checks, set up as `setup` would leave it. */
async function healthy(opts: Parameters<typeof makeCli>[0] = {}): Promise<Cli> {
  const each = await cli(opts);
  await storeClient(each);
  expect(await main(["plugin"], each.deps)).toBe(0);
  each.out.length = 0;
  each.service.registered = true;
  each.helperProcess.running = true;
  return each;
}

describe("renderCheck", () => {
  it("lines up status, label and detail, with the fix last", () => {
    expect(
      renderCheck({ status: "ok", label: "Google client", detail: "config.json (1234-abc.apps.googleusercontent.com)" }),
    ).toBe("ok    Google client   config.json (1234-abc.apps.googleusercontent.com)");
    expect(renderCheck({ status: "fail", label: "Sign-in", detail: "signed out", fix: "figma-font-sync login" })).toBe(
      "fail  Sign-in         signed out (fix: figma-font-sync login)",
    );
  });
});

describe("doctor", () => {
  it("passes on a machine that is set up", async () => {
    const each = await healthy();
    expect(await main(["doctor"], each.deps)).toBe(0);
    expect(each.out).toEqual([
      "ok    Platform        macOS arm64",
      `ok    Google client   config.json (${CLIENT_ID})`,
      "ok    Sign-in         signed in as ada@example.com",
      "ok    Library         font-sync-figma-plugin (editor)",
      `ok    Helper          ${VERSION} on http://localhost:47398`,
      "ok    Start at login  LaunchAgent com.apexialabs.font-sync.plist",
      `ok    Plugin files    ${path.join(each.paths.dataDir, "figma-plugin", "manifest.json")}`,
      "ok    Figma desktop   /Applications/Figma.app",
    ]);
  });

  it("says what is wrong and how to fix it, and exits 1 when a check fails", async () => {
    const each = await cli({
      helper: { status: async (): Promise<Status> => ({ ...SIGNED_IN, auth: "signed-out", account: null, library: null }) },
    });
    each.deps.figmaDesktop = async () => null;
    expect(await main(["doctor"], each.deps)).toBe(1);
    expect(each.out).toEqual([
      "ok    Platform        macOS arm64",
      "fail  Google client   not configured (fix: figma-font-sync setup)",
      "fail  Sign-in         signed out (fix: figma-font-sync login)",
      "warn  Library         unknown until you sign in",
      "fail  Helper          not running on localhost:47398 (fix: figma-font-sync start)",
      "warn  Start at login  No LaunchAgent (fix: figma-font-sync autostart enable)",
      `warn  Plugin files    not installed in ${path.join(each.paths.dataDir, "figma-plugin")} (fix: figma-font-sync plugin)`,
      "warn  Figma desktop   not installed (fix: install it from https://www.figma.com/downloads/)",
    ]);
  });

  it("warns, without failing, about an old helper and old plugin files", async () => {
    const each = await healthy();
    each.helperProcess.version = "0.0.1";
    await writeFile(path.join(each.paths.dataDir, "figma-plugin", ".version"), "0.0.1\n");
    expect(await main(["doctor"], each.deps)).toBe(0);
    expect(each.out).toContain(
      `warn  Helper          0.0.1 is running, this figma-font-sync is ${VERSION} (fix: figma-font-sync restart)`,
    );
    expect(each.out).toContain(
      `warn  Plugin files    from 0.0.1, this figma-font-sync is ${VERSION} (fix: figma-font-sync plugin)`,
    );
  });

  it("fails on an expired sign-in and a library Drive cannot read", async () => {
    const expired = await healthy({ helper: { status: async () => ({ ...SIGNED_IN, auth: "expired", library: null }) } });
    expect(await main(["doctor"], expired.deps)).toBe(1);
    expect(expired.out).toContain("fail  Sign-in         sign-in expired (fix: figma-font-sync login)");

    const broken = await healthy({
      helper: { status: async () => ({ ...SIGNED_IN, library: null, libraryError: "Google Drive: 403 forbidden" }) },
    });
    expect(await main(["doctor"], broken.deps)).toBe(1);
    expect(broken.out).toContain("fail  Library         Google Drive: 403 forbidden");
  });

  it("warns when no library is selected, since the plugin offers a choice", async () => {
    const each = await healthy({ helper: { status: async () => ({ ...SIGNED_IN, library: null }) } });
    expect(await main(["doctor"], each.deps)).toBe(0);
    expect(each.out).toContain(
      "warn  Library         none selected; the plugin offers a choice (fix: figma-font-sync library list)",
    );
  });

  it("turns a check that throws into a failed line and still runs the rest", async () => {
    const each = await healthy();
    each.deps.helper = async () => {
      throw new Error("keychain is locked");
    };
    expect(await main(["doctor"], each.deps)).toBe(1);
    expect(each.out).toContain("fail  Sign-in         keychain is locked");
    expect(each.out).toContain("warn  Library         unknown: could not read the sign-in state");
    expect(each.out).toHaveLength(8);
  });

  it("names the client's source", async () => {
    const each = await healthy();
    each.deps.env = { ...each.deps.env, FONT_SYNC_GOOGLE_CLIENT_ID: "111111111111-env.apps.googleusercontent.com" };
    await main(["doctor"], each.deps);
    expect(each.out).toContain("ok    Google client   FONT_SYNC_GOOGLE_CLIENT_ID (111111111111-env.apps.googleusercontent.com)");
  });

  it("knows Linux has no Figma desktop app", async () => {
    const each = await healthy();
    each.deps.platform = "linux";
    each.deps.arch = "x64";
    each.deps.figmaDesktop = async () => {
      throw new Error("not called on Linux");
    };
    await main(["doctor"], each.deps);
    expect(each.out[0]).toBe("ok    Platform        Linux x64");
    expect(each.out.at(-1)).toBe("warn  Figma desktop   Figma has no Linux desktop app");
  });

  it("warns about a platform without a prebuilt binary", async () => {
    const each = await healthy();
    each.deps.platform = "linux";
    each.deps.arch = "arm64";
    await main(["doctor"], each.deps);
    expect(each.out[0]).toBe("warn  Platform        Linux arm64 has no prebuilt figma-font-sync binary");
  });
});

describe("findFigmaDesktop", () => {
  it("looks in /Applications, then ~/Applications on macOS", async () => {
    expect(figmaDesktopCandidates("darwin", "/Users/ada", {})).toEqual([
      "/Applications/Figma.app",
      "/Users/ada/Applications/Figma.app",
    ]);
    const onlyHome = async (file: string) => file === "/Users/ada/Applications/Figma.app";
    expect(await findFigmaDesktop("darwin", "/Users/ada", {}, onlyHome)).toBe("/Users/ada/Applications/Figma.app");
    expect(await findFigmaDesktop("darwin", "/Users/ada", {}, async () => false)).toBeNull();
  });

  it("looks in %LOCALAPPDATA%\\Figma on Windows", () => {
    expect(figmaDesktopCandidates("win32", "C:\\Users\\ada", { LOCALAPPDATA: "D:\\Local" })).toEqual([
      "D:\\Local\\Figma\\Figma.exe",
    ]);
    expect(figmaDesktopCandidates("win32", "C:\\Users\\ada", { LOCALAPPDATA: "relative" })).toEqual([
      "C:\\Users\\ada\\AppData\\Local\\Figma\\Figma.exe",
    ]);
  });

  it("has nothing to find on Linux", async () => {
    expect(figmaDesktopCandidates("linux", "/home/ada", {})).toEqual([]);
    expect(await findFigmaDesktop("linux", "/home/ada", {}, async () => true)).toBeNull();
  });
});
