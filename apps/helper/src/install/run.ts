export type CommandResult = { code: number; stdout: string; stderr: string };

/**
 * Runs `argv` directly, never through a shell. `env` is added to the inherited environment
 * (PowerShell needs SystemRoot and friends). Rejects when the executable cannot be started.
 */
export type CommandRunner = (
  argv: string[],
  opts?: { env?: Record<string, string>; stdin?: string },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (argv, opts = {}) => {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    // Started at login on Windows the helper may have no console, and then every console child would open a window.
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};
