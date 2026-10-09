import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../config/paths";
import { type CommandRunner, runCommand } from "../install/run";

export type AutostartStatus = { enabled: boolean; detail: string };

/**
 * Starts `font-sync serve` at login as the current user (never as a system service, which would
 * install fonts into the wrong profile):
 *   darwin  ~/Library/LaunchAgents/com.apexialabs.font-sync.plist, RunAtLoad + KeepAlive, launchctl bootstrap gui/<uid>
 *   win32   HKCU\Software\Microsoft\Windows\CurrentVersion\Run value "FontSync"
 *   linux   ~/.config/systemd/user/font-sync.service, systemctl --user enable --now
 * `command` is the full argv to run, e.g. [execPath, "serve"] or [bun, script, "serve"].
 */
export interface Autostart {
  /** `env` is set for the started helper on macOS and Linux; the Windows Run key cannot carry it. */
  enable(command: string[], env?: Record<string, string>): Promise<void>;
  disable(): Promise<void>;
  status(): Promise<AutostartStatus>;
}

export type AutostartDeps = {
  run: CommandRunner;
  /** launchd domain owner; only read on macOS. */
  uid: () => number;
  sleep: (ms: number) => Promise<void>;
};

export function createAutostart(platform: Platform, home: string, env: Record<string, string | undefined>): Autostart {
  return createAutostartWith(platform, home, env, {
    run: runCommand,
    uid: () => process.getuid?.() ?? 0,
    sleep: (ms) => Bun.sleep(ms),
  });
}

/** `createAutostart` with commands, uid and delays injected. Files are written under `home` (or XDG_CONFIG_HOME). */
export function createAutostartWith(
  platform: Platform,
  home: string,
  env: Record<string, string | undefined>,
  deps: AutostartDeps,
): Autostart {
  switch (platform) {
    case "darwin":
      return launchAgent(home, deps);
    case "win32":
      return runKey(deps);
    case "linux":
      return systemdUnit(home, env, deps);
  }
}

export const LAUNCH_AGENT_LABEL = "com.apexialabs.font-sync";

function launchAgent(home: string, deps: AutostartDeps): Autostart {
  const plist = path.join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const log = path.join(home, "Library", "Logs", "font-sync.log");
  // A service target, never the bare gui/<uid> domain: `bootout gui/<uid>` tears down the whole login session.
  const service = () => `gui/${deps.uid()}/${LAUNCH_AGENT_LABEL}`;

  return {
    async enable(command, env) {
      await mkdir(path.dirname(plist), { recursive: true });
      await mkdir(path.dirname(log), { recursive: true });
      // The environment may hold the Google client secret. `mode` only applies when the file is created,
      // so a plist from an older enable needs the chmod too.
      await writeFile(plist, launchAgentPlist(command, log, env), { mode: 0o600 });
      await chmod(plist, 0o600);
      // Fails when nothing is loaded yet, which is fine.
      await deps.run(["launchctl", "bootout", service()]).catch(() => undefined);
      // bootout returns before launchd has finished removing the job, so an immediate bootstrap can fail with
      // "Bootstrap failed: 5: Input/output error" for a moment.
      let result = await deps.run(["launchctl", "bootstrap", `gui/${deps.uid()}`, plist]);
      for (let attempt = 1; result.code !== 0 && attempt < 5; attempt++) {
        await deps.sleep(500);
        result = await deps.run(["launchctl", "bootstrap", `gui/${deps.uid()}`, plist]);
      }
      if (result.code !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim() || result.code}`);
    },

    async disable() {
      await deps.run(["launchctl", "bootout", service()]).catch(() => undefined);
      await rm(plist, { force: true });
    },

    async status() {
      // launchd loads every agent in ~/Library/LaunchAgents at login, so the file is the registration.
      return (await exists(plist))
        ? { enabled: true, detail: `LaunchAgent ${plist}` }
        : { enabled: false, detail: `No LaunchAgent at ${plist}` };
    },
  };
}

export function launchAgentPlist(command: string[], log: string, env: Record<string, string> = {}): string {
  const strings = command.map((arg) => `\n    <string>${xml(arg)}</string>`).join("");
  const variables = Object.entries(env)
    .map(([name, value]) => `\n    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
    .join("");
  const environment = variables ? `\n  <key>EnvironmentVariables</key>\n  <dict>${variables}\n  </dict>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${strings}
  </array>${environment}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "FontSync";

function runKey(deps: AutostartDeps): Autostart {
  async function query() {
    return deps.run(["reg.exe", "query", RUN_KEY, "/v", RUN_VALUE]);
  }

  return {
    async enable(command) {
      const commandLine = command.map(windowsArg).join(" ");
      const args = ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", commandLine, "/f"];
      const result = await deps.run(["reg.exe", ...args]);
      if (result.code !== 0) throw new Error(`reg.exe add failed: ${result.stderr.trim() || result.code}`);
    },

    async disable() {
      if ((await query()).code !== 0) return;
      const result = await deps.run(["reg.exe", "delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
      if (result.code !== 0) throw new Error(`reg.exe delete failed: ${result.stderr.trim() || result.code}`);
    },

    async status() {
      const result = await query();
      if (result.code !== 0) return { enabled: false, detail: `No ${RUN_VALUE} value in ${RUN_KEY}` };
      const data = /\sREG_SZ\s+(.*)$/m.exec(result.stdout)?.[1]?.trim();
      return { enabled: true, detail: data ? `${RUN_VALUE}: ${data}` : `${RUN_VALUE} value in ${RUN_KEY}` };
    },
  };
}

/** Quotes one argument for CommandLineToArgvW, where backslashes are literal unless they precede a quote. */
export function windowsArg(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

const UNIT = "font-sync.service";

function systemdUnit(home: string, env: Record<string, string | undefined>, deps: AutostartDeps): Autostart {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg && path.posix.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  const unitFile = path.join(configHome, "systemd", "user", UNIT);

  async function systemctl(...args: string[]) {
    const result = await deps.run(["systemctl", "--user", ...args]);
    if (result.code !== 0) {
      throw new Error(`systemctl --user ${args.join(" ")} failed: ${result.stderr.trim() || result.code}`);
    }
  }

  return {
    async enable(command, env) {
      await mkdir(path.dirname(unitFile), { recursive: true });
      // The environment may hold the Google client secret. `mode` only applies when the file is created.
      await writeFile(unitFile, systemdUnitFile(command, env), { mode: 0o600 });
      await chmod(unitFile, 0o600);
      await systemctl("daemon-reload");
      await systemctl("enable", "--now", UNIT);
    },

    async disable() {
      // Fails when the unit was never loaded, which is fine: the file is removed either way.
      await systemctl("disable", "--now", UNIT).catch(() => undefined);
      await rm(unitFile, { force: true });
      await systemctl("daemon-reload").catch(() => undefined);
    },

    async status() {
      const result = await deps.run(["systemctl", "--user", "is-enabled", UNIT]).catch(() => null);
      if (result === null) return { enabled: false, detail: "systemctl is not available" };
      const state = result.stdout.trim() || result.stderr.trim();
      return { enabled: result.code === 0 && state === "enabled", detail: `${UNIT}: ${state || "unknown"}` };
    },
  };
}

export function systemdUnitFile(command: string[], env: Record<string, string> = {}): string {
  const environment = Object.entries(env)
    .map(([name, value]) => `Environment=${systemdEnvironment(`${name}=${value}`)}\n`)
    .join("");
  return `[Unit]
Description=Font Sync helper

[Service]
Type=simple
${environment}ExecStart=${command.map(systemdArg).join(" ")}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** systemd unquotes C-style, expands $VAR and %-specifiers inside quotes too, so those are escaped as well. */
function systemdArg(arg: string): string {
  const escaped = arg.replace(/[\\"\n$%]/g, (char) => SYSTEMD_ESCAPES[char] ?? char);
  return `"${escaped}"`;
}

const SYSTEMD_ESCAPES: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", $: "$$", "%": "%%" };

/** Environment= unquotes C-style and expands %-specifiers, but "$" is literal there, unlike in ExecStart=. */
function systemdEnvironment(assignment: string): string {
  const escaped = assignment.replace(/[\\"\n%]/g, (char) => SYSTEMD_ESCAPES[char] ?? char);
  return `"${escaped}"`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
