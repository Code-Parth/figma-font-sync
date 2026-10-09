import type { Platform } from "./config/paths";

/** Starts `argv` without a shell and resolves with its exit code, or null while it is still running. */
export type Launcher = (argv: string[]) => Promise<number | null>;

/** Long enough for `open` and `rundll32`; xdg-open can block until the browser it started exits. */
const LAUNCH_WAIT_MS = 5_000;

/** The argv that opens `url` in the default browser. `url` is passed as one argument, never through a shell. */
export function openCommand(platform: Platform, url: string): string[] {
  switch (platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      return ["rundll32", "url.dll,FileProtocolHandler", url];
    case "linux":
      return ["xdg-open", url];
  }
}

export async function openUrl(url: string, platform: Platform, launch: Launcher = launchProcess): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid web address: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https addresses can be opened, not ${parsed.protocol}`);
  }
  const argv = openCommand(platform, parsed.href);
  let exitCode: number | null;
  try {
    exitCode = await launch(argv);
  } catch (err) {
    throw new Error(`Could not run ${argv[0]} to open a browser: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (exitCode !== null && exitCode !== 0) {
    throw new Error(`${argv[0]} exited with code ${exitCode} while opening a browser`);
  }
}

async function launchProcess(argv: string[]): Promise<number | null> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stillRunning = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LAUNCH_WAIT_MS);
  });
  const result = await Promise.race([child.exited, stillRunning]);
  clearTimeout(timer);
  if (result === null) child.unref();
  return result;
}
