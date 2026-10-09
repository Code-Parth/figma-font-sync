import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type DaemonDeps,
  type PidFile,
  pidFilePath,
  probeHealth,
  readPidFile,
  removePidFile,
  spawnDetached,
  startHelper,
  stopHelper,
  writePidFile,
} from "../../src/cli/daemon";
import { type Platform, resolvePaths } from "../../src/config/paths";
import type { Autostart } from "../../src/service/autostart";

/** Never bound: every request in these tests goes to a fake fetch. */
const PORT = 47398;
const VERSION = "1.2.0";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "font-sync-daemon-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Helpers that answer /health, by port, and the Host headers they were asked with. */
function fakeNetwork() {
  const up = new Map<number, string>();
  const hosts: (string | null)[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    hosts.push(new Headers(init?.headers).get("host"));
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/health") throw new Error(`unexpected fetch ${url.href}`);
    const version = up.get(Number(url.port));
    if (version === undefined) throw new TypeError("Unable to connect. Is the computer able to access the url?");
    return Response.json({ ok: true, name: "font-sync", version });
  }) as typeof fetch;
  return { up, hosts, fetch: fetchImpl };
}

function fakeAutostart(overrides: Partial<Autostart> = {}) {
  const calls: string[] = [];
  const autostart: Autostart = {
    enable: async () => {
      calls.push("enable");
    },
    disable: async () => {
      calls.push("disable");
    },
    status: async () => ({ enabled: false, detail: "fake" }),
    isRegistered: async () => false,
    startService: async () => {
      calls.push("startService");
      return false;
    },
    stopService: async () => {
      calls.push("stopService");
      return false;
    },
    ...overrides,
  };
  return { autostart, calls };
}

type Setup = {
  platform?: Platform;
  autostart?: Autostart;
  /** Runs on every fake sleep, so a test can bring a helper up or down after some polls. */
  onSleep?: (count: number) => void;
};

function setup(options: Setup = {}) {
  const platform = options.platform ?? "darwin";
  const net = fakeNetwork();
  const spawned: { argv: string[]; logFile: string }[] = [];
  const kills: [number, NodeJS.Signals | 0][] = [];
  const sleeps: number[] = [];
  const deps: DaemonDeps = {
    platform,
    paths: resolvePaths("linux", {}, home),
    port: PORT,
    version: VERSION,
    runtime: { serveCommand: ["/data/bin/figma-font-sync-1.2.0", "serve"], fromSource: false },
    autostart: options.autostart ?? fakeAutostart().autostart,
    spawnDetached: (argv, logFile) => {
      spawned.push({ argv, logFile });
      return 4242;
    },
    kill: (pid, signal) => {
      kills.push([pid, signal]);
    },
    fetch: net.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      options.onSleep?.(sleeps.length);
    },
  };
  return { deps, net, spawned, kills, sleeps };
}

const pidInfo = (overrides: Partial<PidFile> = {}): PidFile => ({
  pid: 4242,
  port: PORT,
  version: VERSION,
  startedAt: "2026-10-09T10:00:00.000Z",
  ...overrides,
});

describe("pid file", () => {
  it("round-trips under stateDir", async () => {
    const paths = { stateDir: path.join(home, "state") };
    expect(pidFilePath(paths)).toBe(path.join(home, "state", "helper.pid"));
    expect(await readPidFile(paths)).toBeNull();
    await writePidFile(paths, pidInfo());
    expect(await readPidFile(paths)).toEqual(pidInfo());
  });

  it("reads anything malformed as no pid file", async () => {
    const paths = { stateDir: home };
    for (const text of ["not json", "null", "[]", '{"pid":"12","port":1,"version":"1","startedAt":"x"}', '{"pid":0,"port":1,"version":"1","startedAt":"x"}', '{"pid":12,"port":1}']) {
      await writeFile(pidFilePath(paths), text);
      expect(await readPidFile(paths)).toBeNull();
    }
  });

  it("is removed only by the process it names", async () => {
    const paths = { stateDir: home };
    await writePidFile(paths, pidInfo({ pid: 200 }));
    await removePidFile(paths, 100);
    expect((await readPidFile(paths))?.pid).toBe(200);
    await removePidFile(paths, 200);
    expect(await Bun.file(pidFilePath(paths)).exists()).toBe(false);
    await removePidFile(paths, 200);
  });
});

describe("probeHealth", () => {
  it("asks 127.0.0.1 with Host localhost:<port>, which the helper's host check accepts", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request): Response =>
        request.headers.get("host") === `localhost:${server.port}` && new URL(request.url).pathname === "/health"
          ? Response.json({ ok: true, name: "font-sync", version: "9.9.9" })
          : new Response("wrong host", { status: 421 }),
    });
    try {
      expect(await probeHealth(server.port ?? 0)).toEqual({ running: true, version: "9.9.9" });
    } finally {
      await server.stop(true);
    }
  });

  it("treats other programs, errors and refusals as not running", async () => {
    const answers = [
      () => Response.json({ ok: true, name: "something-else", version: "1" }),
      () => Response.json({ ok: true, name: "font-sync" }),
      () => Response.json({ ok: true, name: "font-sync", version: "1" }, { status: 500 }),
      () => new Response("<html>"),
      () => {
        throw new TypeError("connection refused");
      },
    ];
    for (const answer of answers) {
      expect(await probeHealth(PORT, (async () => answer()) as unknown as typeof fetch)).toEqual({ running: false });
    }
  });

  it("gives up on a port that never answers", async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await probeHealth(PORT, hanging, 50)).toEqual({ running: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("startHelper", () => {
  it("leaves a helper of this version alone", async () => {
    const { autostart, calls } = fakeAutostart();
    const { deps, net, spawned } = setup({ autostart });
    net.up.set(PORT, VERSION);
    expect(await startHelper(deps)).toEqual({
      state: "already-running",
      version: VERSION,
      via: null,
      logFile: path.join(deps.paths.stateDir, "font-sync.log"),
      warning: null,
    });
    expect(spawned).toEqual([]);
    expect(calls).toEqual([]);
    expect(net.hosts.every((host) => host === `localhost:${PORT}`)).toBe(true);
  });

  it("spawns the runtime copy with output in <stateDir>/font-sync.log and waits for /health", async () => {
    let up: () => void = () => undefined;
    const { deps, net, spawned, sleeps } = setup({ onSleep: (count) => count === 3 && up() });
    up = () => net.up.set(PORT, VERSION);
    const logFile = path.join(deps.paths.stateDir, "font-sync.log");
    expect(await startHelper(deps)).toEqual({ state: "started", version: VERSION, via: "process", logFile, warning: null });
    expect(spawned).toEqual([{ argv: ["/data/bin/figma-font-sync-1.2.0", "serve"], logFile }]);
    expect(sleeps).toEqual([250, 250, 250]);
  });

  it("starts through the service manager when start at login is registered", async () => {
    let net: ReturnType<typeof fakeNetwork> | null = null;
    const { autostart, calls } = fakeAutostart({
      logFile: "/Users/ana/Library/Logs/font-sync.log",
      isRegistered: async () => true,
      startService: async () => {
        calls.push("startService");
        net?.up.set(PORT, VERSION);
        return true;
      },
    });
    const ctx = setup({ autostart });
    net = ctx.net;
    expect(await startHelper(ctx.deps)).toEqual({
      state: "started",
      version: VERSION,
      via: "service",
      logFile: "/Users/ana/Library/Logs/font-sync.log",
      warning: null,
    });
    expect(calls).toEqual(["startService"]);
    expect(ctx.spawned).toEqual([]);
  });

  it("spawns when the service manager declines", async () => {
    const { autostart, calls } = fakeAutostart({ isRegistered: async () => true });
    const ctx = setup({ platform: "linux", autostart, onSleep: () => ctx.net.up.set(PORT, VERSION) });
    expect((await startHelper(ctx.deps)).via).toBe("process");
    expect(calls).toEqual(["startService"]);
    expect(ctx.spawned).toHaveLength(1);
  });

  it("spawns, and says how to fix it, when launchd refuses the registered LaunchAgent", async () => {
    const { autostart, calls } = fakeAutostart({
      logFile: "/Users/ana/Library/Logs/font-sync.log",
      isRegistered: async () => true,
      startService: async () => {
        calls.push("startService");
        throw new Error("launchctl bootstrap failed: Bootstrap failed: 5: Input/output error");
      },
    });
    const ctx = setup({ autostart, onSleep: () => ctx.net.up.set(PORT, VERSION) });
    const result = await startHelper(ctx.deps);
    expect(result).toMatchObject({ state: "started", via: "process", logFile: path.join(ctx.deps.paths.stateDir, "font-sync.log") });
    expect(result.warning).toContain("Bootstrap failed: 5: Input/output error");
    expect(result.warning).toContain("Login Items");
    expect(result.warning).toContain('"figma-font-sync autostart disable"');
    expect(calls).toEqual(["startService"]);
    expect(ctx.spawned).toHaveLength(1);
  });

  it("spawns, and points at the unit, when systemd will not start it", async () => {
    const { autostart } = fakeAutostart({
      isRegistered: async () => true,
      startService: async () => {
        throw new Error("systemctl --user restart font-sync.service failed: Unit font-sync.service is masked.");
      },
    });
    const ctx = setup({ platform: "linux", autostart, onSleep: () => ctx.net.up.set(PORT, VERSION) });
    const result = await startHelper(ctx.deps);
    expect(result.via).toBe("process");
    expect(result.warning).toContain("systemctl --user status font-sync.service");
    expect(result.warning).not.toContain("Login Items");
    expect(ctx.spawned).toHaveLength(1);
  });

  it("spawns the background exe on Windows even with the Run key registered", async () => {
    const { autostart, calls } = fakeAutostart({ isRegistered: async () => true });
    const ctx = setup({ platform: "win32", autostart, onSleep: () => ctx.net.up.set(PORT, VERSION) });
    ctx.deps.runtime = { serveCommand: ["C:\\data\\bin\\figma-font-sync-1.2.0-background.exe", "serve"], fromSource: false };
    expect((await startHelper(ctx.deps)).via).toBe("process");
    expect(calls).toEqual([]);
    expect(ctx.spawned[0]?.argv).toEqual(["C:\\data\\bin\\figma-font-sync-1.2.0-background.exe", "serve"]);
  });

  it("stops a helper of another version first", async () => {
    const ctx = setup({ platform: "win32" });
    ctx.net.up.set(PORT, "1.1.0");
    await writePidFile(ctx.deps.paths, pidInfo({ pid: 99, version: "1.1.0" }));
    ctx.deps.kill = (pid, signal) => {
      ctx.kills.push([pid, signal]);
      ctx.net.up.delete(PORT);
    };
    ctx.deps.spawnDetached = (argv, logFile) => {
      ctx.spawned.push({ argv, logFile });
      ctx.net.up.set(PORT, VERSION);
      return 100;
    };
    expect(await startHelper(ctx.deps)).toMatchObject({ state: "restarted", version: VERSION, via: "process" });
    expect(ctx.kills).toEqual([[99, "SIGTERM"]]);
    expect(await readPidFile(ctx.deps.paths)).toBeNull();
  });

  it("gives up after 10 s and points at the log", async () => {
    const { deps, sleeps } = setup();
    const error = await startHelper(deps).catch((err: unknown) => err as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(path.join(deps.paths.stateDir, "font-sync.log"));
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(10_000);
  });

  it("points at the journal when systemd started it", async () => {
    const { autostart } = fakeAutostart({ isRegistered: async () => true, startService: async () => true });
    const { deps } = setup({ platform: "linux", autostart });
    await expect(startHelper(deps)).rejects.toThrow("journalctl --user -u font-sync.service");
  });

  it("says when start at login still runs an older copy", async () => {
    let net: ReturnType<typeof fakeNetwork> | null = null;
    const { autostart } = fakeAutostart({
      isRegistered: async () => true,
      stopService: async () => {
        net?.up.delete(PORT);
        return true;
      },
      startService: async () => {
        net?.up.set(PORT, "1.1.0");
        return true;
      },
    });
    const ctx = setup({ autostart });
    net = ctx.net;
    ctx.net.up.set(PORT, "1.1.0");
    await expect(startHelper(ctx.deps)).rejects.toThrow("autostart enable");
  });
});

describe("stopHelper", () => {
  it("reports a helper that is not running", async () => {
    const { deps, kills } = setup();
    expect(await stopHelper(deps)).toEqual({ state: "not-running", note: null });
    expect(kills).toEqual([]);
  });

  it("stops through launchd when the LaunchAgent is registered, and says it comes back at login", async () => {
    let net: ReturnType<typeof fakeNetwork> | null = null;
    const { autostart, calls } = fakeAutostart({
      isRegistered: async () => true,
      stopService: async () => {
        calls.push("stopService");
        net?.up.delete(PORT);
        return true;
      },
    });
    const ctx = setup({ autostart });
    net = ctx.net;
    ctx.net.up.set(PORT, VERSION);
    const result = await stopHelper(ctx.deps);
    expect(result.state).toBe("stopped");
    expect(result.note).toContain("next login");
    expect(calls).toEqual(["stopService"]);
    expect(ctx.kills).toEqual([]);
  });

  it("signals the pid from helper.pid once its port answers, and waits for it to go", async () => {
    const ctx = setup({ platform: "win32", onSleep: (count) => count === 2 && ctx.net.up.delete(PORT) });
    ctx.net.up.set(PORT, VERSION);
    await writePidFile(ctx.deps.paths, pidInfo({ pid: 321 }));
    expect(await stopHelper(ctx.deps)).toEqual({ state: "stopped", note: null });
    expect(ctx.kills).toEqual([[321, "SIGTERM"]]);
    expect(ctx.sleeps).toEqual([250, 250]);
    expect(await readPidFile(ctx.deps.paths)).toBeNull();
  });

  it("falls back to the pid when the service manager did not own the running helper", async () => {
    const { autostart, calls } = fakeAutostart({
      isRegistered: async () => true,
      stopService: async () => {
        calls.push("stopService");
        return true;
      },
    });
    const ctx = setup({ platform: "linux", autostart });
    ctx.net.up.set(PORT, VERSION);
    ctx.deps.kill = (pid, signal) => {
      ctx.kills.push([pid, signal]);
      ctx.net.up.delete(PORT);
    };
    await writePidFile(ctx.deps.paths, pidInfo({ pid: 321 }));
    expect((await stopHelper(ctx.deps)).state).toBe("stopped");
    expect(calls).toEqual(["stopService"]);
    expect(ctx.kills).toEqual([[321, "SIGTERM"]]);
  });

  it("never signals a pid whose port does not answer, and deletes that stale file", async () => {
    const { deps, kills } = setup();
    await writePidFile(deps.paths, pidInfo({ pid: 321 }));
    expect(await stopHelper(deps)).toEqual({ state: "not-running", note: null });
    expect(kills).toEqual([]);
    expect(await readPidFile(deps.paths)).toBeNull();
  });

  it("refuses to guess when a helper answers but no pid file names it", async () => {
    const { deps, net, kills } = setup({ platform: "win32" });
    net.up.set(PORT, "0.1.0");
    await expect(stopHelper(deps)).rejects.toThrow("helper.pid");
    await writePidFile(deps.paths, pidInfo({ pid: 321, port: 47399 }));
    await expect(stopHelper(deps)).rejects.toThrow("47399");
    expect(kills).toEqual([]);
  });

  it("treats a process that is already gone as stopped", async () => {
    const ctx = setup({ platform: "win32" });
    ctx.net.up.set(PORT, VERSION);
    await writePidFile(ctx.deps.paths, pidInfo({ pid: 321 }));
    ctx.deps.kill = () => {
      ctx.net.up.delete(PORT);
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    expect((await stopHelper(ctx.deps)).state).toBe("stopped");
  });

  it("gives up after 5 s when the helper keeps answering", async () => {
    const ctx = setup({ platform: "win32" });
    ctx.net.up.set(PORT, VERSION);
    await writePidFile(ctx.deps.paths, pidInfo({ pid: 321 }));
    await expect(stopHelper(ctx.deps)).rejects.toThrow("after 5 s");
    expect(ctx.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5000);
  });
});

describe("spawnDetached", () => {
  it("appends the child's stdout and stderr to the log and returns at once", async () => {
    const logFile = path.join(home, "logs", "font-sync.log");
    await mkdir(path.dirname(logFile), { recursive: true });
    await writeFile(logFile, "earlier\n");
    const script = 'console.log("out"); console.error("err")';
    const pid = spawnDetached([process.execPath, "-e", script], logFile);
    expect(pid).toBeGreaterThan(0);
    let text = "";
    for (let attempt = 0; attempt < 100 && !text.includes("err"); attempt++) {
      await Bun.sleep(50);
      text = await readFile(logFile, "utf8");
    }
    expect(text.startsWith("earlier\n")).toBe(true);
    expect(text).toContain("out\n");
    expect(text).toContain("err\n");
  });
});
