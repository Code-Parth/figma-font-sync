import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveGoogleClient } from "../config/google-client";
import type { Platform } from "../config/paths";
import { openConfig } from "../config/store";
import { errorMessage, type Status } from "../helper";
import { type CliDeps, describeAuth, parsePort } from "../main";
import { VERSION } from "../version";
import { probeHealth } from "./daemon";
import { CLI_NAME } from "./runtime";
import { clientSourceLabel } from "./setup";

export type CheckStatus = "ok" | "warn" | "fail";

export type Check = { status: CheckStatus; label: string; detail: string; fix?: string };

/** `ok    Google client   config.json (1234-abc.apps.googleusercontent.com)` */
export function renderCheck(check: Check): string {
  const fix = check.fix ? ` (fix: ${check.fix})` : "";
  return `${check.status.padEnd(6)}${check.label.padEnd(16)}${check.detail}${fix}`;
}

/** Prints one line per check. Exit code 1 when any check failed. */
export async function doctor(deps: CliDeps): Promise<number> {
  const checks = await runChecks(deps);
  for (const check of checks) deps.out(renderCheck(check));
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

/** The compiled targets scripts/build.ts produces; Windows on Arm runs the x64 one emulated. */
const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);

const PLATFORM_NAMES: Record<Platform, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

export async function runChecks(deps: CliDeps): Promise<Check[]> {
  const cmd = (args: string) => `${CLI_NAME} ${args}`;
  const checks: Check[] = [];
  /** One check that throws becomes a failed line instead of hiding the ones after it. */
  const check = async (label: string, run: () => Promise<Omit<Check, "label">>) => {
    try {
      checks.push({ label, ...(await run()) });
    } catch (err) {
      checks.push({ label, status: "fail", detail: errorMessage(err) });
    }
  };

  await check("Platform", async () => {
    const name = `${PLATFORM_NAMES[deps.platform]} ${deps.arch}`;
    return SUPPORTED.has(`${deps.platform}-${deps.arch}`)
      ? { status: "ok", detail: name }
      : { status: "warn", detail: `${name} has no prebuilt ${CLI_NAME} binary` };
  });

  await check("Google client", async () => {
    const found = resolveGoogleClient(deps.env, await openConfig(deps.paths.configDir).read());
    return found
      ? { status: "ok", detail: `${clientSourceLabel(found.source)} (${found.client.clientId})` }
      : { status: "fail", detail: "not configured", fix: cmd("setup") };
  });

  let state: Status | null = null;
  await check("Sign-in", async () => {
    state = await (await deps.helper()).status();
    switch (state.auth) {
      case "signed-in":
        return { status: "ok", detail: describeAuth(state) };
      case "signing-in":
        return { status: "warn", detail: "signing in" };
      case "not-configured":
        return { status: "fail", detail: "needs a Google client", fix: cmd("setup") };
      case "signed-out":
        return { status: "fail", detail: "signed out", fix: cmd("login") };
      case "expired":
        return { status: "fail", detail: "sign-in expired", fix: cmd("login") };
    }
  });

  await check("Library", async () => {
    const current = state;
    if (current === null) return { status: "warn", detail: "unknown: could not read the sign-in state" };
    if (current.auth !== "signed-in") return { status: "warn", detail: "unknown until you sign in" };
    if (current.library) return { status: "ok", detail: `${current.library.name} (${current.library.role})` };
    if (current.libraryError) return { status: "fail", detail: current.libraryError };
    return { status: "warn", detail: "none selected; the plugin offers a choice", fix: cmd("library list") };
  });

  await check("Helper", async () => {
    const port = parsePort(deps.env.FONT_SYNC_PORT);
    const health = await probeHealth(port, deps.fetch);
    if (!health.running) return { status: "fail", detail: `not running on localhost:${port}`, fix: cmd("start") };
    if (health.version !== VERSION) {
      return { status: "warn", detail: `${health.version} is running, this ${CLI_NAME} is ${VERSION}`, fix: cmd("restart") };
    }
    return { status: "ok", detail: `${health.version} on http://localhost:${port}` };
  });

  await check("Start at login", async () => {
    const { enabled, detail } = await deps.autostart().status();
    return enabled ? { status: "ok", detail } : { status: "warn", detail, fix: cmd("autostart enable") };
  });

  await check("Plugin files", async () => {
    const dir = path.join(deps.paths.dataDir, "figma-plugin");
    const manifest = path.join(dir, "manifest.json");
    const version = await readFile(path.join(dir, ".version"), "utf8").then(
      (text) => text.trim(),
      () => null,
    );
    if (version === null || !(await exists(manifest))) {
      return { status: "warn", detail: `not installed in ${dir}`, fix: cmd("plugin") };
    }
    if (version !== VERSION) {
      return { status: "warn", detail: `from ${version}, this ${CLI_NAME} is ${VERSION}`, fix: cmd("plugin") };
    }
    return { status: "ok", detail: manifest };
  });

  await check("Figma desktop", async () => {
    if (deps.platform === "linux") return { status: "warn", detail: "Figma has no Linux desktop app" };
    const app = await deps.figmaDesktop();
    return app
      ? { status: "ok", detail: app }
      : { status: "warn", detail: "not installed", fix: "install it from https://www.figma.com/downloads/" };
  });

  return checks;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
