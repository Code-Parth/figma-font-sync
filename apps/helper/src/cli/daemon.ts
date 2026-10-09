import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Paths, Platform } from "../config/paths";
import { JsonFile } from "../config/store";
import { errorMessage } from "../helper";
import type { Autostart } from "../service/autostart";
import type { Runtime } from "./runtime";

/** `<stateDir>/helper.pid`, written by `serve`. */
export type PidFile = { pid: number; port: number; version: string; startedAt: string };

export function pidFilePath(paths: Pick<Paths, "stateDir">): string {
  return path.join(paths.stateDir, "helper.pid");
}

/** `<stateDir>/font-sync.log`, where a helper started by `start` without a service manager writes. */
export function logFilePath(paths: Pick<Paths, "stateDir">): string {
  return path.join(paths.stateDir, "font-sync.log");
}

function pidStore(paths: Pick<Paths, "stateDir">): JsonFile<unknown> {
  return new JsonFile<unknown>(pidFilePath(paths), () => null);
}

export async function writePidFile(paths: Pick<Paths, "stateDir">, info: PidFile): Promise<void> {
  await pidStore(paths).write(info);
}

/** Deletes the pid file only if it still names `pid`, so an exiting old helper cannot remove a newer one's. */
export async function removePidFile(paths: Pick<Paths, "stateDir">, pid: number): Promise<void> {
  if ((await readPidFile(paths))?.pid === pid) await rm(pidFilePath(paths), { force: true });
}

/** Null when missing or unparsable. */
export async function readPidFile(paths: Pick<Paths, "stateDir">): Promise<PidFile | null> {
  const value = await pidStore(paths).read();
  if (typeof value !== "object" || value === null) return null;
  const { pid, port, version, startedAt } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !Number.isSafeInteger(port)) return null;
  if (typeof version !== "string" || typeof startedAt !== "string") return null;
  return { pid: pid as number, port: port as number, version, startedAt };
}

export type Health = { running: false } | { running: true; version: string };

const HEALTH_TIMEOUT_MS = 1500;

/** GET http://127.0.0.1:<port>/health with Host localhost:<port>; anything but a font-sync answer is not running. */
export async function probeHealth(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<Health> {
  try {
    // 127.0.0.1 skips a "localhost" lookup that may try ::1 first; the helper's Host check wants the name.
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      headers: { Host: `localhost:${port}` },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { running: false };
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return { running: false };
    const { ok, name, version } = body as Record<string, unknown>;
    return ok === true && name === "font-sync" && typeof version === "string"
      ? { running: true, version }
      : { running: false };
  } catch {
    // Refused, timed out or not JSON: some other program, or nothing, is on the port.
    return { running: false };
  }
}

export type DaemonDeps = {
  platform: Platform;
  paths: Paths;
  port: number;
  version: string;
  runtime: Runtime;
  autostart: Autostart;
  /** Starts argv detached from this process with stdout and stderr appended to logFile; returns the pid. */
  spawnDetached: (argv: string[], logFile: string) => number;
  /** process.kill */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type StartResult = {
  state: "already-running" | "started" | "restarted";
  version: string;
  /** "service": through launchd or systemd because start-at-login is registered; "process": spawned. */
  via: "service" | "process" | null;
  logFile: string;
  /** Why the registered service did not start the helper and it was spawned instead, with the fix. */
  warning: string | null;
};

const POLL_MS = 250;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5000;

/**
 * Idempotent. A helper already answering with this version is left alone; one with another version is
 * stopped first. When start-at-login is registered on macOS or Linux the service manager starts it
 * (`launchctl kickstart -k gui/<uid>/<label>`, `systemctl --user restart`); otherwise, or when the service
 * manager refuses, runtime.serveCommand is spawned detached with output in `<stateDir>/font-sync.log`. Waits
 * up to 10 s for /health and throws with the log path if it never answers.
 */
export async function startHelper(deps: DaemonDeps): Promise<StartResult> {
  const processLog = logFilePath(deps.paths);
  const registered = hasServiceManager(deps.platform) && (await deps.autostart.isRegistered());
  const serviceLog = (registered && deps.autostart.logFile) || processLog;
  const current = await probeHealth(deps.port, deps.fetch);
  if (current.running && current.version === deps.version) {
    return { state: "already-running", version: current.version, via: null, logFile: serviceLog, warning: null };
  }
  if (current.running) await stopHelper(deps);

  let via: "service" | "process" = "process";
  let warning: string | null = null;
  if (registered) {
    try {
      if (await deps.autostart.startService()) via = "service";
    } catch (err) {
      // On macOS the plist can stay while launchd refuses to load it (switched off under Login Items), and
      // every start would fail the same way. A helper that runs now beats an error; `stop` still finds it by pid.
      warning = serviceRefused(deps.platform, err);
    }
  }
  if (via === "process") {
    await mkdir(deps.paths.stateDir, { recursive: true });
    deps.spawnDetached(deps.runtime.serveCommand, processLog);
  }
  const logFile = via === "service" ? serviceLog : processLog;

  const health = await waitUntilUp(deps);
  if (health.running && health.version === deps.version) {
    return { state: current.running ? "restarted" : "started", version: health.version, via, logFile, warning };
  }
  if (health.running) {
    throw new Error(
      via === "service"
        ? `Start at login runs version ${health.version}, not ${deps.version}. Run "figma-font-sync autostart enable", then start again.`
        : `Another Font Sync helper (version ${health.version}) answers on port ${deps.port}.`,
    );
  }
  const output = via === "service" && deps.platform === "linux" ? "journalctl --user -u font-sync.service" : logFile;
  throw new Error(`The helper did not answer on http://localhost:${deps.port} within 10 s. See ${output}.`);
}

export type StopResult = { state: "stopped" | "not-running"; note: string | null };

/** Stopping never launches anything, so it needs no runtime copy. */
export type StopDeps = Omit<DaemonDeps, "runtime" | "spawnDetached">;

/**
 * macOS with the LaunchAgent: `launchctl bootout` (KeepAlive respawns a killed process); note that it
 * starts again at next login. Linux with the unit: `systemctl --user stop`. Otherwise SIGTERM the pid from
 * helper.pid, but only after /health shows a helper is listening on the recorded port; waits up to 5 s.
 */
export async function stopHelper(deps: StopDeps): Promise<StopResult> {
  const wasRunning = (await probeHealth(deps.port, deps.fetch)).running;
  let note: string | null = null;

  const registered = hasServiceManager(deps.platform) && (await deps.autostart.isRegistered());
  if (registered && (await deps.autostart.stopService())) {
    note = 'It starts again at next login; "figma-font-sync autostart disable" turns that off.';
    if (await waitUntilDown(deps, deps.port)) {
      await removeStalePidFile(deps);
      return { state: wasRunning ? "stopped" : "not-running", note };
    }
    // Still answering: a helper started by hand before start-at-login was set up. The pid file knows it.
  }

  const info = await readPidFile(deps.paths);
  if (!info) {
    if (!wasRunning) return { state: "not-running", note };
    throw new Error(
      `A Font Sync helper answers on port ${deps.port}, but no ${pidFilePath(deps.paths)} names it (an older version, or started another way). Quit it from Activity Monitor or Task Manager.`,
    );
  }
  // A pid file left by a crash may name a pid the OS has since given to another program.
  if (!(await probeHealth(info.port, deps.fetch)).running) {
    await removePidFile(deps.paths, info.pid);
    if (wasRunning) {
      throw new Error(
        `A Font Sync helper answers on port ${deps.port}, but ${pidFilePath(deps.paths)} names one on port ${info.port}. Quit it from Activity Monitor or Task Manager.`,
      );
    }
    return { state: "not-running", note };
  }

  try {
    deps.kill(info.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ESRCH") throw error;
  }
  if (!(await waitUntilDown(deps, info.port))) {
    throw new Error(`The helper (pid ${info.pid}) is still answering on port ${info.port} after 5 s.`);
  }
  // `serve` removes it on a clean exit; this covers one that was killed harder.
  await removePidFile(deps.paths, info.pid);
  return { state: "stopped", note };
}

/** launchd and systemd supervise the helper; the Windows Run key only launches it at login. */
function hasServiceManager(platform: Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function serviceRefused(platform: Platform, err: unknown): string {
  const fix =
    platform === "darwin"
      ? 'Allow figma-font-sync in System Settings > General > Login Items & Extensions, or run "figma-font-sync autostart disable".'
      : 'See "systemctl --user status font-sync.service", or run "figma-font-sync autostart disable".';
  return `Start at login did not start the helper (${errorMessage(err)}), so it was started directly. ${fix}`;
}

/** The last /health answer, once it shows this version or after 10 s. */
async function waitUntilUp(deps: DaemonDeps): Promise<Health> {
  const started = Date.now();
  for (let waited = 0; ; waited += POLL_MS) {
    const health = await probeHealth(deps.port, deps.fetch);
    if (health.running && health.version === deps.version) return health;
    // The wall clock also counts, because a port that accepts but never answers costs a probe timeout each time.
    if (waited >= START_TIMEOUT_MS || Date.now() - started >= START_TIMEOUT_MS) return health;
    await sleep(deps, POLL_MS);
  }
}

/** True once /health on `port` stops answering, within 5 s. */
async function waitUntilDown(deps: StopDeps, port: number): Promise<boolean> {
  const started = Date.now();
  for (let waited = 0; ; waited += POLL_MS) {
    if (!(await probeHealth(port, deps.fetch)).running) return true;
    if (waited >= STOP_TIMEOUT_MS || Date.now() - started >= STOP_TIMEOUT_MS) return false;
    await sleep(deps, POLL_MS);
  }
}

async function removeStalePidFile(deps: StopDeps): Promise<void> {
  const info = await readPidFile(deps.paths);
  if (info && !(await probeHealth(info.port, deps.fetch)).running) await removePidFile(deps.paths, info.pid);
}

function sleep(deps: StopDeps, ms: number): Promise<void> {
  return deps.sleep ? deps.sleep(ms) : Bun.sleep(ms);
}

/**
 * The CLI's DaemonDeps.spawnDetached: a new session (setsid) so closing the terminal does not stop the
 * helper, output appended to logFile, and no console window on Windows.
 */
export function spawnDetached(argv: string[], logFile: string): number {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a", 0o600);
  try {
    const child = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
      windowsHide: true,
    });
    // Otherwise `start` would wait for the helper to exit.
    child.unref();
    return child.pid;
  } finally {
    // The child has its own copy of the descriptor.
    closeSync(fd);
  }
}
