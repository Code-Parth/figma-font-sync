import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writePidFile } from "../../src/cli/daemon";
import type { Status } from "../../src/helper";
import { main } from "../../src/main";
import { VERSION } from "../../src/version";
import { SIGNED_IN } from "../api/support";
import { type Cli, CLIENT_ID, makeCli, TEST_PORT } from "./cli-support";

const SIGNED_OUT: Status = { ...SIGNED_IN, auth: "signed-out", account: null, library: null };

const made: Cli[] = [];

afterEach(async () => {
  for (const each of made.splice(0)) await each.cleanup();
});

/** An installed binary unless `fromSource`: setup treats a checkout differently. */
async function cli(opts: Parameters<typeof makeCli>[0] & { fromSource?: boolean } = {}): Promise<Cli> {
  const created = await makeCli(opts);
  made.push(created);
  if (!opts.fromSource) {
    const binary = path.join(created.root, "figma-font-sync");
    await writeFile(binary, "binary");
    created.deps.standalone = true;
    created.deps.execPath = binary;
  }
  return created;
}

function runtimeCopy(each: Cli): string {
  return path.join(each.paths.dataDir, "bin", `figma-font-sync-${VERSION}`);
}

async function storedClient(each: Cli): Promise<unknown> {
  const text = await readFile(path.join(each.paths.configDir, "config.json"), "utf8").catch(() => "{}");
  return (JSON.parse(text) as { googleClient?: unknown }).googleClient;
}

async function storeClient(each: Cli, clientId = CLIENT_ID): Promise<void> {
  await mkdir(each.paths.configDir, { recursive: true });
  await writeFile(
    path.join(each.paths.configDir, "config.json"),
    JSON.stringify({ libraryFolderId: null, pairedClients: [], googleClient: { clientId, clientSecret: "GOCSPX-old" } }),
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** A helper that is signed out until its login finishes. */
function signsIn() {
  let state = SIGNED_OUT;
  const logins: number[] = [];
  return {
    logins,
    helper: {
      status: async () => state,
      login: async () => {
        logins.push(1);
        state = SIGNED_IN;
        return { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", done: Promise.resolve() };
      },
    },
  };
}

describe("setup", () => {
  it("takes the client from flags without a terminal and sets everything else up with defaults", async () => {
    const each = await cli();
    const code = await main(["setup", "--client-id", CLIENT_ID, "--client-secret", " GOCSPX-abc "], each.deps);
    expect(each.err).toEqual([]);
    expect(code).toBe(0);
    expect(await storedClient(each)).toEqual({ clientId: CLIENT_ID, clientSecret: "GOCSPX-abc" });

    const manifest = path.join(each.paths.dataDir, "figma-plugin", "manifest.json");
    expect(await exists(manifest)).toBe(true);
    expect(each.calls.enabled).toEqual([{ command: [runtimeCopy(each), "serve"], env: {} }]);
    expect(each.calls.serviceStarts).toBe(1);
    expect(each.helperProcess.running).toBe(true);
    // Never prompts without a terminal.
    expect(each.calls.prompts).toBe(0);

    const out = each.out.join("\n");
    expect(out).toContain("[1/4] Google client");
    expect(out).toContain(`Saved ${CLIENT_ID} in ${path.join(each.paths.configDir, "config.json")}`);
    expect(out).toContain(manifest);
    expect(out).toContain("Start the helper whenever you log in? [Y/n] yes");
    expect(out).toContain(`Started the Font Sync helper ${VERSION} on http://localhost:47398 through launchd.`);
    expect(out).toContain('Skipped: signing in needs a terminal. Run "figma-font-sync login".');
    expect(each.out.slice(-5)).toEqual([
      "Font Sync is set up.",
      `  Google client   config.json (${CLIENT_ID})`,
      `  Figma plugin    ${manifest}`,
      "  Helper          running on http://localhost:47398, starts at login",
      "Next: open Figma desktop and run Plugins > Development > Font Sync",
    ]);
    expect(out).not.toContain("GOCSPX");
  });

  it("asks for the client in a terminal, asking again until the id is valid", async () => {
    const signing = signsIn();
    const each = await cli({
      interactive: true,
      helper: signing.helper,
      answers: ["not-a-client-id", CLIENT_ID, "", "", "y"],
    });
    expect(await main(["setup"], each.deps)).toBe(0);
    expect(each.prompt.asked).toEqual([
      "Client id",
      "Client id",
      "Client secret (leave blank if it has none)",
      "Start the helper whenever you log in?",
      "Sign in with Google now?",
    ]);
    expect(each.prompt.closed).toBe(true);
    expect(await storedClient(each)).toEqual({ clientId: CLIENT_ID, clientSecret: null });

    const out = each.out.join("\n");
    expect(out).toContain('Google Cloud "Desktop app" OAuth client');
    expect(out).toContain("https://www.npmjs.com/package/figma-font-sync#google-cloud-setup");
    expect(out).toContain("A Google client ID looks like");
    expect(signing.logins).toHaveLength(1);
    expect(out).toContain("Signed in as ada@example.com.");
    expect(out).toContain("  Google          signed in as ada@example.com");
  });

  it("keeps a configured client and does not ask for one", async () => {
    const each = await cli({ interactive: true, answers: ["", ""] });
    await storeClient(each);
    expect(await main(["setup"], each.deps)).toBe(0);
    expect(each.prompt.asked).toEqual(["Start the helper whenever you log in?"]);
    expect(each.out).toContain(`Using ${CLIENT_ID} from config.json.`);
    // The fake helper is already signed in.
    expect(each.out).toContain("Already signed in as ada@example.com.");
    expect(await storedClient(each)).toEqual({ clientId: CLIENT_ID, clientSecret: "GOCSPX-old" });
  });

  it("replaces a configured client when flags are given", async () => {
    const other = "999999999999-zzz.apps.googleusercontent.com";
    const each = await cli();
    await storeClient(each);
    expect(await main(["setup", "--client-id", other, "--no-login"], each.deps)).toBe(0);
    expect(await storedClient(each)).toEqual({ clientId: other, clientSecret: null });
  });

  it("signs out of the old client's sign-in when --client-id replaces it, then offers sign-in", async () => {
    const other = "999999999999-zzz.apps.googleusercontent.com";
    let state = SIGNED_IN;
    let clientAtLogout: unknown = null;
    const each: Cli = await cli({
      interactive: true,
      helper: {
        status: async () => state,
        logout: async () => {
          clientAtLogout = await storedClient(each);
          state = SIGNED_OUT;
          return state;
        },
        login: async () => {
          state = SIGNED_IN;
          return { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", done: Promise.resolve() };
        },
      },
      answers: ["", "y"],
    });
    await storeClient(each);
    expect(await main(["setup", "--client-id", other, "--client-secret", "GOCSPX-new"], each.deps)).toBe(0);
    expect(each.calls.logouts).toBe(1);
    // Signed out before the new client is saved, so a failed sign-out leaves the old setup whole.
    expect(clientAtLogout).toEqual({ clientId: CLIENT_ID, clientSecret: "GOCSPX-old" });
    expect(await storedClient(each)).toEqual({ clientId: other, clientSecret: "GOCSPX-new" });
    expect(each.out).toContain("Signed out of Google: the new client needs a new sign-in.");
    expect(each.out.join("\n")).not.toContain("Already signed in");
    expect(each.prompt.asked).toContain("Sign in with Google now?");
    expect(each.out).toContain("Signed in as ada@example.com.");
  });

  it("keeps the sign-in when the client in effect does not change", async () => {
    const each = await cli();
    await storeClient(each);
    // Same client id with a corrected secret: Google's refresh token still belongs to it.
    expect(await main(["setup", "--client-id", CLIENT_ID, "--client-secret", "GOCSPX-fixed", "--no-login"], each.deps)).toBe(0);
    expect(each.calls.logouts).toBe(0);

    // The environment's client wins over config.json in this shell, before and after.
    const shell = await cli();
    await storeClient(shell);
    shell.deps.env = { ...shell.deps.env, FONT_SYNC_GOOGLE_CLIENT_ID: "111111111111-env.apps.googleusercontent.com" };
    const other = "999999999999-zzz.apps.googleusercontent.com";
    expect(await main(["setup", "--client-id", other, "--no-autostart", "--no-login"], shell.deps)).toBe(0);
    expect(shell.calls.logouts).toBe(0);
    expect(shell.out.join("\n")).not.toContain("Signed out");
  });

  it("fails without a client when it cannot ask, and changes nothing", async () => {
    const each = await cli();
    expect(await main(["setup"], each.deps)).toBe(1);
    expect(each.err[0]).toBe(
      "figma-font-sync: no Google client is configured. Run setup in a terminal without --yes to be asked, or pass it:",
    );
    expect(each.err[1]).toBe("  figma-font-sync setup --client-id <id>.apps.googleusercontent.com --client-secret <secret>");
    expect(each.calls.enabled).toEqual([]);
    expect(await exists(path.join(each.paths.dataDir, "figma-plugin"))).toBe(false);
  });

  it("does not ask with --yes, even in a terminal", async () => {
    const each = await cli({ interactive: true });
    expect(await main(["setup", "--yes"], each.deps)).toBe(1);
    expect(each.calls.prompts).toBe(0);
  });

  it("rejects an invalid --client-id as bad usage", async () => {
    const each = await cli();
    expect(await main(["setup", "--client-id", "GOCSPX-oops"], each.deps)).toBe(2);
    expect(each.err[0]).toStartWith("figma-font-sync: That is the client secret.");
    expect(await storedClient(each)).toBeUndefined();
  });

  it("warns that a client in this shell's environment wins over the one it saves", async () => {
    const each = await cli();
    each.deps.env = { ...each.deps.env, FONT_SYNC_GOOGLE_CLIENT_ID: "111111111111-env.apps.googleusercontent.com" };
    expect(await main(["setup", "--client-id", CLIENT_ID, "--no-autostart"], each.deps)).toBe(0);
    expect(each.err.join("\n")).toContain("FONT_SYNC_GOOGLE_CLIENT_ID in this shell overrides the saved client");
  });

  it("with --no-autostart only asks whether to start the helper now", async () => {
    const each = await cli({ interactive: true, answers: ["n"] });
    await storeClient(each);
    expect(await main(["setup", "--no-autostart", "--no-login"], each.deps)).toBe(0);
    expect(each.prompt.asked).toEqual(["Start the helper now?"]);
    expect(each.calls.enabled).toEqual([]);
    expect(each.calls.spawned).toEqual([]);
    expect(each.out).toContain('  Helper          not running (run "figma-font-sync start")');
    expect(each.out).toContain('Skipped. Sign in later with "figma-font-sync login".');

    const started = await cli({ interactive: true, answers: ["y"] });
    await storeClient(started);
    expect(await main(["setup", "--no-autostart", "--no-login"], started.deps)).toBe(0);
    expect(started.calls.spawned).toHaveLength(1);
    expect(started.out).toContain("  Helper          running on http://localhost:47398");
  });

  it("with --no-autostart still points an earlier start-at-login registration at the new copy", async () => {
    const each = await cli();
    await storeClient(each);
    const binary = path.join(each.root, "figma-font-sync");
    await writeFile(binary, "binary");
    each.deps.standalone = true;
    each.deps.execPath = binary;
    each.service.registered = true;
    expect(await main(["setup", "--no-autostart", "--no-login"], each.deps)).toBe(0);
    const copy = path.join(each.paths.dataDir, "bin", `figma-font-sync-${VERSION}`);
    expect(each.calls.enabled).toEqual([{ command: [copy, "serve"], env: {} }]);
    expect(each.calls.serviceStarts).toBe(1);
  });

  it("offers to start the helper now when start at login is declined", async () => {
    const each = await cli({ interactive: true, answers: ["n", "y"] });
    await storeClient(each);
    expect(await main(["setup", "--no-login"], each.deps)).toBe(0);
    expect(each.prompt.asked).toEqual(["Start the helper whenever you log in?", "Start the helper now?"]);
    expect(each.calls.enabled).toEqual([]);
    expect(each.calls.spawned).toHaveLength(1);
  });

  it("does not sign in with --no-login", async () => {
    const signing = signsIn();
    const each = await cli({ interactive: true, helper: signing.helper, answers: [""] });
    await storeClient(each);
    expect(await main(["setup", "--no-login"], each.deps)).toBe(0);
    expect(signing.logins).toEqual([]);
    expect(each.prompt.asked).toEqual(["Start the helper whenever you log in?"]);
  });

  it("leaves sign-in for later when declined", async () => {
    const signing = signsIn();
    const each = await cli({ interactive: true, helper: signing.helper, answers: ["", "n"] });
    await storeClient(each);
    expect(await main(["setup"], each.deps)).toBe(0);
    expect(signing.logins).toEqual([]);
    expect(each.out).toContain('Sign in later with "figma-font-sync login".');
    expect(each.out).toContain('  Google          signed out (run "figma-font-sync login")');
  });

  it("still prints the summary and exits 1 when sign-in does not finish", async () => {
    const each = await cli({
      interactive: true,
      helper: {
        status: async () => SIGNED_OUT,
        login: async () => ({
          url: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
          done: Promise.reject(new Error("Sign-in timed out.")),
        }),
      },
      answers: ["", "y"],
    });
    await storeClient(each);
    expect(await main(["setup"], each.deps)).toBe(1);
    expect(each.err).toContain("figma-font-sync: sign-in did not finish: Sign-in timed out.");
    expect(each.out).toContain("Setup finished with problems:");
    expect(each.out.at(-1)).toBe("Next: open Figma desktop and run Plugins > Development > Font Sync");
  });

  it("from source, leaves start at login off unless asked, so the checkout does not run at every login", async () => {
    const each = await cli({ fromSource: true });
    await storeClient(each);
    expect(await main(["setup", "--no-login"], each.deps)).toBe(0);
    expect(each.out).toContain("Running from source: start at login defaults to no.");
    expect(each.calls.enabled).toEqual([]);
    expect(each.calls.spawned).toHaveLength(1);

    const asked = await cli({ fromSource: true, interactive: true, answers: ["y"] });
    await storeClient(asked);
    expect(await main(["setup", "--no-login"], asked.deps)).toBe(0);
    expect(asked.calls.enabled[0]?.command).toEqual(["/opt/bun/bin/bun", "/repo/apps/helper/src/main.ts", "serve"]);
  });

  it("stops a helper that start spawned before launchd starts the registered one", async () => {
    const order: string[] = [];
    const each = await cli({
      autostart: {
        enable: async () => {
          order.push("enable");
          each.service.registered = true;
        },
      },
    });
    await storeClient(each);
    const kill = each.deps.kill;
    each.deps.kill = (pid, signal) => {
      order.push(`kill ${pid} ${signal}`);
      kill(pid, signal);
    };
    each.helperProcess.running = true;
    await writePidFile(each.paths, { pid: 4242, port: Number(TEST_PORT), version: VERSION, startedAt: "2026-01-01T00:00:00.000Z" });
    expect(await main(["setup", "--no-login"], each.deps)).toBe(0);
    expect(order).toEqual(["kill 4242 SIGTERM", "enable"]);
    expect(each.calls.serviceStarts).toBe(1);
    expect(each.calls.spawned).toEqual([]);
  });

  it("runs the helper anyway when launchd refuses start at login, without asking launchd twice", async () => {
    const refused = new Error("launchctl bootstrap failed: Bootstrap failed: 5: Input/output error");
    let enables = 0;
    const each = await cli({
      autostart: {
        // The plist stays on disk while Login Items keeps launchd from loading it.
        isRegistered: async () => true,
        enable: async () => {
          enables += 1;
          throw refused;
        },
        startService: async () => {
          throw refused;
        },
      },
    });
    await storeClient(each);
    const binary = path.join(each.root, "figma-font-sync");
    await writeFile(binary, "binary");
    each.deps.standalone = true;
    each.deps.execPath = binary;
    expect(await main(["setup", "--no-login"], each.deps)).toBe(1);
    expect(enables).toBe(1);
    expect(each.calls.spawned).toHaveLength(1);
    expect(each.err).toEqual([
      `figma-font-sync: could not turn on start at login: ${refused.message}`,
      expect.stringContaining("System Settings > General > Login Items"),
    ]);
    expect(each.out).toContain("  Helper          running on http://localhost:47398");
  });

  it("finishes the other steps and exits 1 when the helper does not start", async () => {
    const signing = signsIn();
    // Registered, but the service never brings up a helper that answers.
    const each = await cli({
      interactive: true,
      helper: signing.helper,
      autostart: { startService: async () => true },
      answers: ["", "y"],
    });
    await storeClient(each);
    expect(await main(["setup"], each.deps)).toBe(1);
    expect(each.err.join("\n")).toContain("figma-font-sync: could not start the helper:");
    expect(signing.logins).toHaveLength(1);
    expect(each.out).toContain("Setup finished with problems:");
    expect(each.out).toContain('  Helper          not running (run "figma-font-sync start"), starts at login');
  });
});
