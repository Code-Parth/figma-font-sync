import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Prompt, parseYesNo } from "../../src/cli/prompt";
import { resolvePaths } from "../../src/config/paths";
import type { Helper } from "../../src/helper";
import type { CliDeps } from "../../src/main";
import type { Autostart } from "../../src/service/autostart";
import { VERSION } from "../../src/version";
import { fakeHelper } from "../api/support";

export const CLIENT_ID = "123456789012-abc123def456.apps.googleusercontent.com";

/** Never 47321: the user's own helper may be listening there. Only the fake fetch ever sees it anyway. */
export const TEST_PORT = "47398";

/** Answers questions from a script, in order, and records every question asked. */
export function scriptedPrompt(answers: string[]): Prompt & { asked: string[]; closed: boolean } {
  const asked: string[] = [];
  const next = (question: string) => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`No scripted answer for "${question}"`);
    return answer.trim();
  };
  return {
    asked,
    closed: false,
    async ask(question, opts = {}) {
      return next(question) || (opts.default ?? "");
    },
    async confirm(question, defaultYes) {
      const answer = parseYesNo(next(question));
      if (answer === null) throw new Error(`Scripted answer to "${question}" is not yes or no`);
      return answer === "default" ? defaultYes : answer;
    },
    close() {
      this.closed = true;
    },
  };
}

type Options = {
  helper?: Partial<Helper>;
  autostart?: Partial<Autostart>;
  interactive?: boolean;
  answers?: string[];
};

/**
 * CliDeps over a temp home on macOS paths, a plugin source with a built manifest, a fake helper process
 * whose /health the fake fetch answers, and a fake start-at-login service. Nothing reaches the network,
 * launchd, the keychain or the user's real config.
 */
export async function makeCli(opts: Options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-font-sync-cli-"));
  const home = path.join(root, "home");
  const paths = resolvePaths("darwin", {}, home);
  const pluginSource = path.join(root, "plugin");
  await mkdir(path.join(pluginSource, "dist"), { recursive: true });
  await writeFile(
    path.join(pluginSource, "manifest.json"),
    JSON.stringify({ name: "Font Sync", id: "font-sync", api: "1.0.0", main: "dist/code.js", ui: "dist/ui.html" }),
  );
  await writeFile(path.join(pluginSource, "dist", "code.js"), "figma.showUI(__html__);");
  await writeFile(path.join(pluginSource, "dist", "ui.html"), "<!doctype html><title>Font Sync</title>");

  const fake = fakeHelper(opts.helper);
  const out: string[] = [];
  const err: string[] = [];
  /** The background helper: /health answers while `running`. */
  const helperProcess = { running: false, version: VERSION };
  const service = { registered: false };
  const calls = {
    enabled: [] as { command: string[]; env: Record<string, string> | undefined }[],
    disabled: 0,
    serviceStarts: 0,
    serviceStops: 0,
    spawned: [] as { argv: string[]; logFile: string }[],
    killed: [] as { pid: number; signal: NodeJS.Signals | 0 }[],
    logouts: 0,
    prompts: 0,
  };
  const autostart: Autostart = {
    enable: async (command, env) => {
      calls.enabled.push({ command, env });
      service.registered = true;
    },
    disable: async () => {
      calls.disabled += 1;
      service.registered = false;
    },
    status: async () =>
      service.registered
        ? { enabled: true, detail: "LaunchAgent com.apexialabs.font-sync.plist" }
        : { enabled: false, detail: "No LaunchAgent" },
    isRegistered: async () => service.registered,
    startService: async () => {
      if (!service.registered) return false;
      calls.serviceStarts += 1;
      helperProcess.running = true;
      return true;
    },
    stopService: async () => {
      if (!service.registered) return false;
      calls.serviceStops += 1;
      helperProcess.running = false;
      return true;
    },
    logFile: path.join(home, "Library", "Logs", "font-sync.log"),
    ...opts.autostart,
  };
  const fetchHealth = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!helperProcess.running || url.pathname !== "/health") throw new TypeError("Unable to connect");
    return Response.json({ ok: true, name: "font-sync", version: helperProcess.version });
  }) as typeof fetch;
  const prompt = scriptedPrompt(opts.answers ?? []);
  const logout = fake.helper.logout;
  fake.helper.logout = async () => {
    calls.logouts += 1;
    return logout();
  };

  const deps: CliDeps = {
    platform: "darwin",
    arch: "arm64",
    env: { FONT_SYNC_PORT: TEST_PORT },
    paths,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    helper: async () => fake.helper,
    autostart: () => autostart,
    main: "/repo/apps/helper/src/main.ts",
    execPath: "/opt/bun/bin/bun",
    standalone: false,
    pluginSource: () => pluginSource,
    interactive: opts.interactive ?? false,
    prompt: () => {
      calls.prompts += 1;
      return prompt;
    },
    figmaDesktop: async () => "/Applications/Figma.app",
    spawnDetached: (argv, logFile) => {
      calls.spawned.push({ argv, logFile });
      helperProcess.running = true;
      return 4242;
    },
    kill: (pid, signal) => {
      calls.killed.push({ pid, signal });
      if (signal !== 0) helperProcess.running = false;
    },
    fetch: fetchHealth,
    sleep: async () => {},
  };
  return {
    root,
    home,
    paths,
    pluginSource,
    deps,
    out,
    err,
    calls,
    service,
    helperProcess,
    prompt,
    fake,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export type Cli = Awaited<ReturnType<typeof makeCli>>;
