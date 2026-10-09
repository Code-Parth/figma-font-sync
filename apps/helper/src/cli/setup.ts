import path from "node:path";
import { type GoogleClientSource, resolveGoogleClient, saveGoogleClient, validateClientId } from "../config/google-client";
import { openConfig } from "../config/store";
import { errorMessage, type Status } from "../helper";
import {
  type CliDeps,
  daemonDeps,
  describeAuth,
  describeStart,
  parsePort,
  refreshPluginFiles,
  registerCurrentRuntime,
  runtimeInput,
  shellClientEnv,
  signIn,
  startAtLoginClientNote,
  stopDeps,
} from "../main";
import { startHelper, stopHelper } from "./daemon";
import { figmaImportSteps } from "./plugin-files";
import { defaultsPrompt, type Prompt } from "./prompt";
import { CLI_NAME, installRuntime } from "./runtime";

export type SetupOptions = {
  /** --client-id; null keeps a configured client or asks for one. */
  clientId: string | null;
  /** --client-secret; only with --client-id. */
  clientSecret: string | null;
  /** False with --no-autostart. */
  autostart: boolean;
  /** False with --no-login. */
  login: boolean;
  /** --yes: every question takes its default. */
  yes: boolean;
};

export const GOOGLE_SETUP_URL = "https://www.npmjs.com/package/figma-font-sync#google-cloud-setup";

/** Where a client came from, in a few words. */
export function clientSourceLabel(source: GoogleClientSource): string {
  switch (source) {
    case "env":
      return "FONT_SYNC_GOOGLE_CLIENT_ID";
    case "config":
      return "config.json";
    case "built-in":
      return "built into this binary";
  }
}

/**
 * `figma-font-sync setup`: Google client, runtime copy and plugin files, start at login, sign-in, in that
 * order, each step usable again on an already set up machine. Never asks without a terminal or with --yes.
 */
export async function setup(options: SetupOptions, deps: CliDeps): Promise<number> {
  const asking = deps.interactive && !options.yes;
  const prompt = asking ? deps.prompt() : defaultsPrompt(deps.out);
  try {
    return await runSetup(options, deps, prompt, asking);
  } finally {
    prompt.close();
  }
}

async function runSetup(options: SetupOptions, deps: CliDeps, prompt: Prompt, asking: boolean): Promise<number> {
  const { out } = deps;
  const port = parsePort(deps.env.FONT_SYNC_PORT);
  const problems: string[] = [];
  const problem = (message: string) => {
    deps.err(`${CLI_NAME}: ${message}`);
    problems.push(message);
  };

  out("[1/4] Google client");
  const config = openConfig(deps.paths.configDir);
  const configFile = path.join(deps.paths.configDir, "config.json");
  if (options.clientId !== null) {
    const clientId = options.clientId.trim();
    const invalid = validateClientId(clientId);
    if (invalid) {
      deps.err(`${CLI_NAME}: ${invalid}`);
      return 2;
    }
    const replacement = { clientId, clientSecret: options.clientSecret };
    const before = resolveGoogleClient(deps.env, await config.read());
    const after = resolveGoogleClient(deps.env, { googleClient: replacement });
    // Google ties a refresh token to the client that got it. Kept, it reads as signed in while every refresh
    // fails, and step 4 would skip sign-in. Signing out before saving means a failed sign-out changes nothing.
    const signOut = before !== null && before.client.clientId !== after?.client.clientId;
    if (signOut) await (await deps.helper()).logout();
    await saveGoogleClient(config, replacement);
    out(`Saved ${clientId} in ${configFile}`);
    if (signOut) out("Signed out of Google: the new client needs a new sign-in.");
    if (deps.env.FONT_SYNC_GOOGLE_CLIENT_ID) {
      deps.err(`${CLI_NAME}: FONT_SYNC_GOOGLE_CLIENT_ID in this shell overrides the saved client for commands run from it.`);
    }
  } else {
    const found = resolveGoogleClient(deps.env, await config.read());
    if (found) {
      out(`Using ${found.client.clientId} from ${clientSourceLabel(found.source)}.`);
    } else if (!asking) {
      deps.err(`${CLI_NAME}: no Google client is configured. Run setup in a terminal without --yes to be asked, or pass it:`);
      deps.err(`  ${CLI_NAME} setup --client-id <id>.apps.googleusercontent.com --client-secret <secret>`);
      deps.err(`How to create one: ${GOOGLE_SETUP_URL}`);
      return 1;
    } else {
      out('Font Sync signs in to Google Drive through a Google Cloud "Desktop app" OAuth client, which your');
      out("team admin creates once for everyone. Ask them for its client id and secret. How to create one:");
      out(GOOGLE_SETUP_URL);
      const clientId = await askClientId(prompt, out);
      const clientSecret = await prompt.ask("Client secret (leave blank if it has none)");
      await saveGoogleClient(config, { clientId, clientSecret: clientSecret || null });
      out(`Saved in ${configFile}`);
    }
  }
  const client = resolveGoogleClient(deps.env, await config.read());

  out("");
  out("[2/4] Helper program and Figma plugin");
  const runtime = await installRuntime(runtimeInput(deps));
  if (!runtime.fromSource) out(`Helper program: ${runtime.serveCommand[0]}`);
  const plugin = await refreshPluginFiles(deps);
  for (const line of figmaImportSteps(plugin.manifestPath, deps.platform)) out(line);

  out("");
  out("[3/4] Background helper");
  const autostart = deps.autostart();
  let atLogin = false;
  let enableTried = false;
  let startNow: boolean;
  // From source, start at login would run this checkout at every login, holding the port `dev` wants.
  if (runtime.fromSource && options.autostart) out("Running from source: start at login defaults to no.");
  if (options.autostart && (await prompt.confirm("Start the helper whenever you log in?", !runtime.fromSource))) {
    const clientEnv = shellClientEnv(deps.env);
    enableTried = true;
    try {
      // launchd and systemd start the helper as soon as it is registered. One that `start` spawned would keep
      // the port, and launchd's KeepAlive would retry the refused copy forever.
      if (deps.platform !== "win32") await stopHelper(stopDeps(deps, autostart));
      await autostart.enable(runtime.serveCommand, clientEnv);
      atLogin = true;
      out("The helper will start when you log in.");
      const note = startAtLoginClientNote(clientEnv, deps.platform);
      if (note) deps.err(`${CLI_NAME}: ${note}`);
    } catch (err) {
      problem(`could not turn on start at login: ${errorMessage(err)}`);
    }
    startNow = true;
  } else {
    startNow = await prompt.confirm("Start the helper now?", true);
  }
  let running = false;
  if (startNow) {
    try {
      // A registration left from an earlier setup may name a copy installRuntime just deleted. When the enable
      // above failed, a second one would only fail the same way and wait out launchctl's retries again.
      if (!enableTried) await registerCurrentRuntime(deps, runtime, autostart);
      const result = await startHelper(daemonDeps(deps, runtime, autostart));
      for (const line of describeStart(result, port, deps.platform)) out(line);
      if (result.warning) deps.err(`${CLI_NAME}: ${result.warning}`);
      running = true;
    } catch (err) {
      problem(`could not start the helper: ${errorMessage(err)}`);
    }
  }

  out("");
  out("[4/4] Google sign-in");
  let google: Status | null = null;
  if (!options.login) {
    out(`Skipped. Sign in later with "${CLI_NAME} login".`);
  } else if (!deps.interactive) {
    out(`Skipped: signing in needs a terminal. Run "${CLI_NAME} login".`);
  } else {
    const helper = await deps.helper();
    google = await helper.status();
    if (google.auth === "signed-in") {
      out(`Already ${describeAuth(google)}.`);
    } else if (await prompt.confirm("Sign in with Google now?", true)) {
      try {
        google = await signIn(helper, out);
      } catch (err) {
        problem(`sign-in did not finish: ${errorMessage(err)}`);
      }
    } else {
      out(`Sign in later with "${CLI_NAME} login".`);
    }
  }

  out("");
  out(problems.length > 0 ? "Setup finished with problems:" : "Font Sync is set up.");
  for (const message of problems) out(`  ${message}`);
  out(`  Google client   ${client ? `${clientSourceLabel(client.source)} (${client.client.clientId})` : "none"}`);
  out(`  Figma plugin    ${plugin.manifestPath}`);
  const helperState = running ? `running on http://localhost:${port}` : `not running (run "${CLI_NAME} start")`;
  out(`  Helper          ${helperState}${atLogin ? ", starts at login" : ""}`);
  if (google) out(`  Google          ${describeAuth(google)}`);
  out("Next: open Figma desktop and run Plugins > Development > Font Sync");
  return problems.length > 0 ? 1 : 0;
}

async function askClientId(prompt: Prompt, out: (line: string) => void): Promise<string> {
  for (;;) {
    const clientId = await prompt.ask("Client id");
    const invalid = validateClientId(clientId);
    if (invalid === null) return clientId;
    out(invalid);
  }
}
