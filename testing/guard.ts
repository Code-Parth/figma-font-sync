// Preloaded before every test file (bunfig.toml [test] preload). Tests inject fakes for the OS, the keychain
// and Google; this catches the one that forgets. A test once ran the CLI with real dependencies and
// rewrote the developer's LaunchAgent, and a temp HOME alone would not have stopped it: Bun.secrets and
// launchctl ignore HOME.
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { basename, join } from "node:path";

const home = mkdtempSync(join(os.tmpdir(), "font-sync-test-home-"));
// Bun's os.homedir() does not follow a changed HOME, so default CLI wiring would still find real folders.
mock.module("node:os", () => ({ ...os, default: { ...os, homedir: () => home }, homedir: () => home }));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  FONT_SYNC_NO_BROWSER: "1",
});
// A developer's real client would turn "not configured" tests into real sign-ins.
delete process.env.FONT_SYNC_GOOGLE_CLIENT_ID;
delete process.env.FONT_SYNC_GOOGLE_CLIENT_SECRET;

/** Programs that change the real machine: start-at-login, the registry, the keychain, browsers. */
const BLOCKED = new Set(["launchctl", "systemctl", "reg", "powershell", "pwsh", "schtasks", "security", "open", "xdg-open", "rundll32", "fc-cache"]);

function program(args: unknown[]): string | undefined {
  const [first] = args;
  const argv = Array.isArray(first) ? first : (first as { cmd?: unknown } | undefined)?.cmd;
  const name = Array.isArray(argv) ? argv[0] : undefined;
  return typeof name === "string" ? basename(name).toLowerCase().replace(/\.exe$/, "") : undefined;
}

function refuse(what: string): never {
  throw new Error(`testing/guard.ts: a test tried to ${what}. Inject a fake instead.`);
}

const realSpawn = Bun.spawn;
const realSpawnSync = Bun.spawnSync;
const guardedSpawn = (...args: unknown[]) => {
  const name = program(args);
  if (name && BLOCKED.has(name)) refuse(`run ${name}`);
  return (realSpawn as (...a: unknown[]) => unknown)(...args);
};
const guardedSpawnSync = (...args: unknown[]) => {
  const name = program(args);
  if (name && BLOCKED.has(name)) refuse(`run ${name}`);
  return (realSpawnSync as (...a: unknown[]) => unknown)(...args);
};
Object.assign(Bun, {
  spawn: guardedSpawn,
  spawnSync: guardedSpawnSync,
  secrets: {
    get: () => refuse("read the OS keychain"),
    set: () => refuse("write the OS keychain"),
    delete: () => refuse("delete from the OS keychain"),
  },
});

const realFetch = globalThis.fetch;
const GOOGLE = /(^|\.)(googleapis\.com|google\.com)$/;
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (GOOGLE.test(url.hostname)) refuse(`call ${url.hostname}`);
    return realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
) as typeof fetch;
