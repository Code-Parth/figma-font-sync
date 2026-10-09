#!/usr/bin/env bun
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { format } from "node:util";
import { createApp } from "./api/app";
import {
  type DaemonDeps,
  logFilePath,
  probeHealth,
  removePidFile,
  type StartResult,
  type StopDeps,
  spawnDetached,
  startHelper,
  stopHelper,
  writePidFile,
} from "./cli/daemon";
import { doctor } from "./cli/doctor";
import { findFigmaDesktop } from "./cli/figma-desktop";
import { figmaImportSteps, installPluginFiles, type PluginInstall, pluginSourceDir } from "./cli/plugin-files";
import { Cancelled, type Prompt, terminalPrompt } from "./cli/prompt";
import { CLI_NAME, installRuntime, type Runtime, type RuntimeInput } from "./cli/runtime";
import { type SetupOptions, setup } from "./cli/setup";
import { type UninstallOptions, uninstall } from "./cli/uninstall";
import { currentPlatform, type Paths, type Platform, resolvePaths } from "./config/paths";
import { createHelper, errorMessage, type Helper, type Status } from "./helper";
import { LIBRARY_FOLDER_NAME, type LibraryFile } from "./library/library";
import { openUrl } from "./open-url";
import { type Autostart, createAutostart } from "./service/autostart";
import { VERSION } from "./version";

/** Also hard-coded in apps/plugin/manifest.json: Figma only lets the plugin reach listed origins. */
export const DEFAULT_PORT = 47321;

export type Command =
  | { name: "serve" | "login" | "logout" | "status" | "version" | "help" }
  | { name: "start" | "stop" | "restart" | "plugin" | "doctor" }
  | ({ name: "setup" } & SetupOptions)
  | ({ name: "uninstall" } & UninstallOptions)
  | { name: "library"; action: "list" | "create" }
  | { name: "library"; action: "use"; folderId: string }
  | { name: "sync"; dryRun: boolean }
  | { name: "autostart"; action: "enable" | "disable" | "status" }
  | { name: "pairs"; action: "list" | "revoke-all" };

export class UsageError extends Error {
  override name = "UsageError";
}

export const USAGE = `Font Sync helper ${VERSION}

Usage: ${CLI_NAME} [command]

  setup                     Set up this computer: Google client, Figma plugin, start at login, sign-in
    --client-id <id>          Google "Desktop app" OAuth client id, instead of asking
    --client-secret <secret>  Its client secret
    --no-autostart            Do not start the helper at login
    --no-login                Do not offer to sign in
    --yes                     Take every default without asking
  doctor                    Check this computer's setup and say how to fix what is wrong
  plugin                    Write the Figma plugin files and show how to import them
  start                     Start the helper in the background
  stop                      Stop the background helper
  restart                   Stop and start the background helper
  serve                     Run the helper in this terminal on http://localhost:${DEFAULT_PORT} (the default)
  login                     Sign in with Google
  logout                    Sign out of Google
  status                    Show sign-in, library, start-at-login and pairing state
  library list              List the ${LIBRARY_FOLDER_NAME} folders you can see
  library use <folder>      Use a library folder, by id or Drive folder URL
  library create            Create a library folder in your My Drive and use it
  sync [--dry-run]          Install every library font that is missing or outdated
  autostart enable          Start the helper when you log in
  autostart disable         Stop starting the helper at login
  autostart status          Show whether the helper starts at login
  pairs list                List paired Figma plugins
  pairs revoke-all          Unpair every plugin
  uninstall [--purge]       Stop the helper and delete its files; --purge also deletes settings and sign-in
    --yes                     Do not ask for confirmation
  version                   Print the version
  help                      Show this help

Environment:
  FONT_SYNC_PORT                     Port to listen on (default ${DEFAULT_PORT}; the plugin expects ${DEFAULT_PORT})
  FONT_SYNC_GOOGLE_CLIENT_ID         Google "Desktop app" OAuth client id
  FONT_SYNC_GOOGLE_CLIENT_SECRET     Its client secret
  FONT_SYNC_NO_BROWSER=1             Print links instead of opening a browser`;

const SIMPLE_COMMANDS = [
  "serve",
  "login",
  "logout",
  "status",
  "version",
  "help",
  "start",
  "stop",
  "restart",
  "plugin",
  "doctor",
] as const;

export function parseCommand(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined) return { name: "serve" };
  if (first === "--help" || first === "-h") return { name: "help" };
  if (first === "--version" || first === "-v") return { name: "version" };

  const simple = SIMPLE_COMMANDS.find((name) => name === first);
  if (simple) {
    expectNoMore(first, rest);
    return { name: simple };
  }

  const [action, ...args] = rest;
  switch (first) {
    case "setup":
      return { name: "setup", ...parseSetup(rest) };
    case "uninstall":
      return { name: "uninstall", ...parseUninstall(rest) };
    case "library":
      if (action === "list" || action === "create") {
        expectNoMore(`library ${action}`, args);
        return { name: "library", action };
      }
      if (action === "use") {
        const [target, ...extra] = args;
        if (target === undefined) throw new UsageError("library use needs a folder id or a Drive folder URL.");
        expectNoMore("library use", extra);
        const folderId = parseFolderId(target);
        if (!folderId) throw new UsageError(`Not a Drive folder id or folder URL: ${target}`);
        return { name: "library", action: "use", folderId };
      }
      throw new UsageError("library needs one of: list, use <folder>, create.");
    case "sync": {
      const unknown = rest.filter((arg) => arg !== "--dry-run");
      expectNoMore("sync", unknown);
      return { name: "sync", dryRun: rest.includes("--dry-run") };
    }
    case "autostart":
      if (action === "enable" || action === "disable" || action === "status") {
        expectNoMore(`autostart ${action}`, args);
        return { name: "autostart", action };
      }
      throw new UsageError("autostart needs one of: enable, disable, status.");
    case "pairs":
      if (action === "list" || action === "revoke-all") {
        expectNoMore(`pairs ${action}`, args);
        return { name: "pairs", action };
      }
      throw new UsageError("pairs needs one of: list, revoke-all.");
    default:
      throw new UsageError(`Unknown command: ${first}`);
  }
}

function expectNoMore(command: string, extra: readonly string[]): void {
  if (extra.length > 0) throw new UsageError(`${command} does not take ${extra.join(" ")}`);
}

function parseSetup(args: readonly string[]): SetupOptions {
  const options: SetupOptions = { clientId: null, clientSecret: null, autostart: true, login: true, yes: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const [flag = "", inline] = arg.startsWith("--") ? splitOnce(arg, "=") : [arg];
    if (seen.has(flag)) throw new UsageError(`setup got ${flag} twice.`);
    seen.add(flag);
    if (flag === "--client-id" || flag === "--client-secret") {
      let value = inline;
      if (value === undefined) {
        value = args[i + 1];
        i++;
      }
      // A flag in the value's place means the value was left out.
      if (value === undefined || value.startsWith("--")) throw new UsageError(`setup ${flag} needs a value.`);
      if (flag === "--client-id") options.clientId = value;
      else options.clientSecret = value;
      continue;
    }
    if (inline !== undefined) throw new UsageError(`setup ${flag} does not take a value.`);
    if (flag === "--no-autostart") options.autostart = false;
    else if (flag === "--no-login") options.login = false;
    else if (flag === "--yes") options.yes = true;
    else throw new UsageError(`setup does not take ${arg}`);
  }
  if (options.clientSecret !== null && options.clientId === null) {
    throw new UsageError("setup --client-secret needs --client-id too.");
  }
  return options;
}

function parseUninstall(args: readonly string[]): UninstallOptions {
  const unknown = args.filter((arg) => arg !== "--purge" && arg !== "--yes");
  expectNoMore("uninstall", unknown);
  return { purge: args.includes("--purge"), yes: args.includes("--yes") };
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator);
  return at === -1 ? [value, undefined] : [value.slice(0, at), value.slice(at + separator.length)];
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;

/**
 * A folder id from a bare id or a drive.google.com link: /drive/folders/<id>, /drive/u/<n>/folders/<id>,
 * /open?id=<id> and /folderview?id=<id>. Null for anything else.
 */
export function parseFolderId(input: string): string | null {
  const value = input.trim();
  if (DRIVE_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname !== "drive.google.com") return null;
  const id = /\/folders\/([^/?#]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("id");
  return id && DRIVE_ID.test(id) ? id : null;
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`FONT_SYNC_PORT must be a port number from 1 to 65535, not "${value}".`);
  }
  return port;
}

export type CliDeps = {
  platform: Platform;
  /** process.arch */
  arch: string;
  env: Record<string, string | undefined>;
  paths: Paths;
  out: (line: string) => void;
  err: (line: string) => void;
  helper: () => Promise<Helper>;
  autostart: () => Autostart;
  /** Bun.main, process.execPath and Bun.isStandaloneExecutable: what the runtime copy is made from. */
  main: string;
  execPath: string;
  standalone: boolean;
  /** Where the Figma plugin files are copied from (pluginSourceDir). */
  pluginSource: () => string;
  /** stdin is a terminal, so setup and uninstall may ask. */
  interactive: boolean;
  /** Only called when `interactive`; the caller closes it. */
  prompt: () => Prompt;
  /** Path of the installed Figma desktop app, or null. */
  figmaDesktop: () => Promise<string | null>;
  spawnDetached: DaemonDeps["spawnDetached"];
  kill: DaemonDeps["kill"];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

function defaultDeps(): CliDeps {
  const platform: Platform = currentPlatform();
  const env = process.env;
  const home = homedir();
  const standalone = Bun.isStandaloneExecutable;
  return {
    platform,
    arch: process.arch,
    env,
    paths: resolvePaths(platform, env, home),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    helper: () => createHelper({ platform, env, home, openUrl: (url) => openUrl(url, platform) }),
    autostart: () => createAutostart(platform, home, env),
    main: Bun.main,
    execPath: process.execPath,
    standalone,
    // pluginSourceDir wants src/cli's directory from source; compiled, every module's is the embedded root.
    pluginSource: () => pluginSourceDir(standalone, standalone ? import.meta.dir : join(import.meta.dir, "cli")),
    interactive: process.stdin.isTTY === true,
    prompt: () => terminalPrompt(),
    figmaDesktop: () => findFigmaDesktop(platform, home, env),
    spawnDetached,
    kill: (pid, signal) => process.kill(pid, signal),
  };
}

/** Returns the process exit code: 0 ok, 1 failed, 2 bad usage. `serve` resolves when stopped by a signal. */
export async function main(argv: readonly string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.err(`${CLI_NAME}: ${err.message}`);
    deps.err(`Run "${CLI_NAME} help" for the list of commands.`);
    return 2;
  }
  try {
    return await run(command, deps);
  } catch (err) {
    // What a shell reports for Ctrl+C.
    if (err instanceof Cancelled) return 130;
    deps.err(`${CLI_NAME}: ${errorMessage(err)}`);
    return 1;
  }
}

export async function run(command: Command, deps: CliDeps): Promise<number> {
  switch (command.name) {
    case "help":
      deps.out(USAGE);
      return 0;
    case "version":
      deps.out(VERSION);
      return 0;
    case "serve":
      return serve(deps);
    case "setup":
      return setup(command, deps);
    case "start":
      return start(deps);
    case "stop":
      return stop(deps);
    case "restart":
      await stop(deps, { restarting: true });
      return start(deps);
    case "plugin":
      return plugin(deps);
    case "doctor":
      return doctor(deps);
    case "uninstall":
      return uninstall(command, deps);
    case "login":
      return login(deps);
    case "logout":
      await (await deps.helper()).logout();
      deps.out("Signed out of Google.");
      return 0;
    case "status":
      return status(deps);
    case "library":
      return library(command, deps);
    case "sync":
      return sync(command.dryRun, deps);
    case "autostart":
      return autostart(command.action, deps);
    case "pairs":
      return pairs(command.action, deps);
  }
}

async function serve(deps: CliDeps): Promise<number> {
  const port = parsePort(deps.env.FONT_SYNC_PORT);
  // Figma reads development plugins from disk, so an upgraded helper brings the plugin users imported along.
  await refreshPluginFiles(deps).catch((err: unknown) => {
    deps.err(`${CLI_NAME}: could not update the Figma plugin files: ${errorMessage(err)}`);
  });
  const helper = await deps.helper();
  const app = createApp(helper, { port });
  const listen = {
    port,
    // Bun's default 10 s idle timeout also counts while a handler is still working, so it dropped Install all,
    // big uploads and the first GET /library/files of a large library. Its maximum, 255 s, is still too
    // short. Both listeners are loopback-only, so turning it off costs nothing.
    idleTimeout: 0,
    // createApp enforces the real limit (MAX_REQUEST_BYTES). Bun's own 413 has no CORS headers, so the
    // plugin would only see a network error.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch: app.fetch,
  };
  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    servers.push(Bun.serve({ hostname: "127.0.0.1", ...listen }));
  } catch (err) {
    if (isAddressInUse(err)) {
      deps.err(`Port ${port} is busy. Is the Font Sync helper already running?`);
      return 1;
    }
    throw err;
  }
  try {
    // "localhost" may resolve to ::1 first; without this listener those requests would be refused.
    servers.push(Bun.serve({ hostname: "::1", ...listen }));
  } catch (err) {
    if (isAddressInUse(err)) deps.err(`${CLI_NAME}: [::1]:${port} is in use by another program; serving 127.0.0.1 only.`);
  }

  // `stop` uses it to find this process; without it `stop` still works through the service manager.
  const pid = process.pid;
  await writePidFile(deps.paths, { pid, port, version: VERSION, startedAt: new Date().toISOString() }).catch(
    (err: unknown) => deps.err(`${CLI_NAME}: could not write the pid file: ${errorMessage(err)}`),
  );
  deps.out(`Font Sync helper ${VERSION} listening on http://localhost:${port}`);
  const state = await helper.status();
  if (state.auth === "not-configured") {
    deps.err(`${CLI_NAME}: Google sign-in is not configured. Run "${CLI_NAME} setup".`);
  }

  return new Promise<number>((resolve) => {
    const stop = () => {
      for (const server of servers) server.stop(true);
      removePidFile(deps.paths, pid)
        .catch(() => undefined)
        .then(() => resolve(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function isAddressInUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
}

async function login(deps: CliDeps): Promise<number> {
  await signIn(await deps.helper(), deps.out);
  return 0;
}

/** The `login` flow; `setup` runs it too. The running helper picks the new token up from the secret store. */
export async function signIn(helper: Helper, out: (line: string) => void): Promise<Status> {
  const { url, done } = await helper.login();
  out("Sign in with Google in your browser. If no browser opened, visit:");
  out(url);
  out("Waiting for sign-in (Ctrl+C to cancel)...");
  await done;
  const state = await helper.status();
  out(`Signed in${state.account ? ` as ${state.account.email}` : ""}.`);
  out(`Library: ${describeLibrary(state)}`);
  return state;
}

/** What `installRuntime` copies the running program from. */
export function runtimeInput(deps: CliDeps): RuntimeInput {
  return {
    platform: deps.platform,
    paths: deps.paths,
    version: VERSION,
    execPath: deps.execPath,
    main: deps.main,
    standalone: deps.standalone,
  };
}

export function stopDeps(deps: CliDeps, autostart: Autostart = deps.autostart()): StopDeps {
  return {
    platform: deps.platform,
    paths: deps.paths,
    port: parsePort(deps.env.FONT_SYNC_PORT),
    version: VERSION,
    autostart,
    kill: deps.kill,
    fetch: deps.fetch,
    sleep: deps.sleep,
  };
}

export function daemonDeps(deps: CliDeps, runtime: Runtime, autostart: Autostart = deps.autostart()): DaemonDeps {
  return { ...stopDeps(deps, autostart), runtime, spawnDetached: deps.spawnDetached };
}

export function refreshPluginFiles(deps: CliDeps): Promise<PluginInstall> {
  return installPluginFiles(deps.paths.dataDir, VERSION, deps.pluginSource());
}

async function start(deps: CliDeps): Promise<number> {
  const runtime = await installRuntime(runtimeInput(deps));
  await refreshPluginFiles(deps).catch((err: unknown) => {
    deps.err(`${CLI_NAME}: could not update the Figma plugin files: ${errorMessage(err)}`);
  });
  const autostart = deps.autostart();
  await registerCurrentRuntime(deps, runtime, autostart);
  const port = parsePort(deps.env.FONT_SYNC_PORT);
  const result = await startHelper(daemonDeps(deps, runtime, autostart));
  for (const line of describeStart(result, port, deps.platform)) deps.out(line);
  if (result.warning) deps.err(`${CLI_NAME}: ${result.warning}`);
  return 0;
}

/**
 * installRuntime deletes older copies, which start at login may still name, so a registered service is
 * pointed at this version's copy before anything starts it. Skipped while this version already answers,
 * because re-registering a LaunchAgent restarts it, and from source, which must not replace a binary's
 * registration with the repo. A failure only warns: startHelper spawns the helper when the service will not.
 */
export async function registerCurrentRuntime(deps: CliDeps, runtime: Runtime, autostart: Autostart): Promise<void> {
  if (runtime.fromSource || !(await autostart.isRegistered())) return;
  const health = await probeHealth(parsePort(deps.env.FONT_SYNC_PORT), deps.fetch);
  if (health.running && health.version === VERSION) return;
  try {
    await autostart.enable(runtime.serveCommand, shellClientEnv(deps.env));
  } catch (err) {
    deps.err(`${CLI_NAME}: could not point start at login at this version: ${errorMessage(err)}`);
  }
}

export function describeStart(result: StartResult, port: number, platform: Platform): string[] {
  const where = `http://localhost:${port}`;
  if (result.state === "already-running") return [`The Font Sync helper ${result.version} is already running on ${where}.`];
  const how =
    result.via === "service" ? ` through ${platform === "darwin" ? "launchd" : "systemd"}` : " in the background";
  const what = result.state === "restarted" ? "Replaced the running helper with version" : "Started the Font Sync helper";
  return [`${what} ${result.version} on ${where}${how}.`, `Log: ${result.logFile}`];
}

async function stop(deps: CliDeps, opts: { restarting?: boolean } = {}): Promise<number> {
  const result = await stopHelper(stopDeps(deps));
  deps.out(result.state === "stopped" ? "Stopped the Font Sync helper." : "The Font Sync helper is not running.");
  // The note says when it comes back by itself, which a restart makes moot.
  if (result.note && !opts.restarting) deps.out(result.note);
  return 0;
}

async function plugin(deps: CliDeps): Promise<number> {
  const { manifestPath } = await refreshPluginFiles(deps);
  for (const line of figmaImportSteps(manifestPath, deps.platform)) deps.out(line);
  return 0;
}

async function status(deps: CliDeps): Promise<number> {
  const helper = await deps.helper();
  const state = await helper.status();
  const clients = await helper.pairing.clients();
  // Start-at-login state is secondary here; a failing launchctl or reg query should not hide the rest.
  const start = await deps
    .autostart()
    .status()
    .catch((err: unknown) => ({ enabled: false, detail: `could not check: ${errorMessage(err)}` }));
  deps.out(`Font Sync helper ${state.version} on ${state.platform}`);
  deps.out(`Google:     ${describeAuth(state)}`);
  deps.out(`Library:    ${describeLibrary(state)}`);
  if (state.library) deps.out(`            ${state.library.webViewLink}`);
  deps.out(`Autostart:  ${start.enabled ? "on" : "off"} (${start.detail})`);
  deps.out(`Paired:     ${clients.length === 1 ? "1 plugin" : `${clients.length} plugins`}`);
  return 0;
}

export function describeAuth(state: Status): string {
  switch (state.auth) {
    case "not-configured":
      return `not configured (run "${CLI_NAME} setup")`;
    case "signed-out":
      return `signed out (run "${CLI_NAME} login")`;
    case "signing-in":
      return "signing in";
    case "signed-in":
      return state.account ? `signed in as ${state.account.email}` : "signed in";
    case "expired":
      return `sign-in expired (run "${CLI_NAME} login")`;
  }
}

export function describeLibrary(state: Status): string {
  if (state.auth !== "signed-in") return "unknown until you sign in";
  const lib = state.library;
  if (!lib) return `none selected (run "${CLI_NAME} library list")`;
  const owner = lib.owner ? `, owned by ${lib.owner}` : "";
  return `${lib.name} (${lib.role}${owner}${lib.canUpload ? ", can upload" : ""})`;
}

async function library(command: Extract<Command, { name: "library" }>, deps: CliDeps): Promise<number> {
  const helper = await deps.helper();
  if (command.action === "use") {
    deps.out(`Library: ${describeLibrary(await helper.selectLibrary(command.folderId))}`);
    return 0;
  }
  if (command.action === "create") {
    const state = await helper.createLibrary();
    deps.out(`Created and selected: ${describeLibrary(state)}`);
    if (state.library) deps.out(`Share it with your team in Drive: ${state.library.webViewLink}`);
    return 0;
  }
  const [{ folders, incomplete }, state] = await Promise.all([helper.candidates(), helper.status()]);
  if (folders.length === 0 && incomplete) {
    deps.err(
      `${CLI_NAME}: Google Drive answered with a partial search and found no ${LIBRARY_FOLDER_NAME} folder. Try again in a minute.`,
    );
    return 1;
  }
  if (incomplete) deps.err(`${CLI_NAME}: Google Drive answered with a partial search; a shared folder may be missing.`);
  if (folders.length === 0) {
    deps.out(`No folders named ${LIBRARY_FOLDER_NAME} are shared with you.`);
    deps.out(`Ask the library owner to share it, or run "${CLI_NAME} library create".`);
    return 0;
  }
  for (const folder of folders) {
    const mark = folder.id === state.library?.id ? "*" : " ";
    deps.out(`${mark} ${folder.id}  ${folder.owner ?? "unknown owner"}  modified ${folder.modifiedTime.slice(0, 10)}`);
  }
  if (!state.library) deps.out(`Pick one with "${CLI_NAME} library use <id>".`);
  return 0;
}

export function libraryFileLabel(file: Pick<LibraryFile, "path" | "name">): string {
  return file.path ? `${file.path}/${file.name}` : file.name;
}

async function sync(dryRun: boolean, deps: CliDeps): Promise<number> {
  const helper = await deps.helper();
  const { files } = await helper.files({ refresh: true });
  const pending = files.filter((file) => file.install === "not-installed" || file.install === "outdated");
  // A file that does not parse cannot install; listing it as a failure on every run helps nobody.
  const unreadable = pending.filter((file) => file.parseError !== null);
  const todo = pending.filter((file) => file.parseError === null);
  for (const file of unreadable) deps.out(`skip     ${libraryFileLabel(file)}: ${file.parseError}`);
  if (todo.length === 0) {
    deps.out("Every library font is installed.");
    return 0;
  }
  for (const file of todo) deps.out(`${file.install === "outdated" ? "update " : "install"}  ${libraryFileLabel(file)}`);
  if (dryRun) {
    deps.out(`${todo.length} ${todo.length === 1 ? "file" : "files"} would be installed.`);
    return 0;
  }

  const { results, reloadRequired } = await helper.install(todo.map((file) => file.id));
  const byId = new Map(todo.map((file) => [file.id, file]));
  const failed = results.filter((result) => !result.ok);
  for (const result of failed) {
    const file = byId.get(result.fileId);
    deps.err(`failed   ${file ? libraryFileLabel(file) : result.fileId}: ${result.error ?? "unknown error"}`);
  }
  deps.out(`Installed ${results.length - failed.length} of ${results.length}.`);
  if (reloadRequired) deps.out("Reload open Figma files to see new fonts (right-click the tab > Reload tab).");
  return failed.length > 0 ? 1 : 0;
}

/**
 * launchd and systemd start the helper without this shell's environment, and the environment wins over
 * config.json, so the service gets the client this shell would use.
 */
export function shellClientEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clientEnv: Record<string, string> = {};
  if (env.FONT_SYNC_GOOGLE_CLIENT_ID) {
    clientEnv.FONT_SYNC_GOOGLE_CLIENT_ID = env.FONT_SYNC_GOOGLE_CLIENT_ID;
    if (env.FONT_SYNC_GOOGLE_CLIENT_SECRET) clientEnv.FONT_SYNC_GOOGLE_CLIENT_SECRET = env.FONT_SYNC_GOOGLE_CLIENT_SECRET;
  }
  return clientEnv;
}

/** A warning when start-at-login gets, or cannot get, the client from this shell. */
export function startAtLoginClientNote(clientEnv: Record<string, string>, platform: Platform): string | null {
  if (!clientEnv.FONT_SYNC_GOOGLE_CLIENT_ID) return null;
  return platform === "win32"
    ? `start-at-login on Windows does not see this shell's FONT_SYNC_GOOGLE_CLIENT_ID; save the client with "${CLI_NAME} setup --client-id <id> --client-secret <secret>" unless config.json already has it.`
    : "start-at-login will use FONT_SYNC_GOOGLE_CLIENT_ID and FONT_SYNC_GOOGLE_CLIENT_SECRET from this shell.";
}

async function autostart(action: "enable" | "disable" | "status", deps: CliDeps): Promise<number> {
  const service = deps.autostart();
  if (action === "enable") {
    const clientEnv = shellClientEnv(deps.env);
    // Never the binary npm or install.sh put on PATH: an upgrade could not replace it while the helper runs.
    const runtime = await installRuntime(runtimeInput(deps));
    // launchd and systemd start the helper as soon as it is registered. One that `start` spawned would keep
    // the port, and launchd's KeepAlive would retry the refused copy forever.
    if (deps.platform !== "win32") await stopHelper(stopDeps(deps, service));
    await service.enable(runtime.serveCommand, clientEnv);
    deps.out("The Font Sync helper will start when you log in.");
    const note = startAtLoginClientNote(clientEnv, deps.platform);
    if (note) deps.err(`${CLI_NAME}: ${note}`);
  } else if (action === "disable") {
    await service.disable();
    deps.out("The Font Sync helper will no longer start when you log in.");
  } else {
    const state = await service.status();
    deps.out(`${state.enabled ? "on" : "off"}: ${state.detail}`);
  }
  return 0;
}

async function pairs(action: "list" | "revoke-all", deps: CliDeps): Promise<number> {
  const helper = await deps.helper();
  if (action === "revoke-all") {
    const count = await helper.pairing.revokeAll();
    deps.out(`Revoked ${count === 1 ? "1 pairing" : `${count} pairings`}. Plugins have to pair again.`);
    return 0;
  }
  const clients = await helper.pairing.clients();
  if (clients.length === 0) deps.out("No plugins are paired.");
  for (const client of clients) {
    const lastUsed = client.lastUsedAt ? `last used ${client.lastUsedAt}` : "never used";
    deps.out(`${client.name}  paired ${client.createdAt}, ${lastUsed}  (${client.id})`);
  }
  return 0;
}

/**
 * The console-less Windows copy (figma-font-sync-<version>-background.exe in <dataDir>\bin, or the
 * release's figma-font-sync-background.exe) has nowhere to print, so its output goes to a log file
 * instead, as the macOS LaunchAgent's does.
 */
function logToFileWhenBackground(): void {
  if (process.platform !== "win32" || !win32.basename(process.execPath).toLowerCase().endsWith("-background.exe")) return;
  const paths = resolvePaths("win32", process.env, homedir());
  mkdirSync(paths.stateDir, { recursive: true });
  const log = createWriteStream(logFilePath(paths), { flags: "a" });
  // Losing log lines must not stop the helper.
  log.on("error", () => undefined);
  const write = (...args: unknown[]) => {
    log.write(`${format(...args)}\n`);
  };
  console.log = write;
  console.error = write;
  console.warn = write;
}

if (import.meta.main) {
  logToFileWhenBackground();
  process.exit(await main(process.argv.slice(2)));
}
