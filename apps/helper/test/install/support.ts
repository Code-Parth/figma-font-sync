import type { CommandResult, CommandRunner } from "../../src/install/run";
import type { Face } from "../../src/fonts/types";

export function face(overrides: Partial<Face> = {}): Face {
  return {
    family: "Inter",
    style: "Bold",
    postscript: "Inter-Bold",
    fullName: "Inter Bold",
    legacyFamily: "Inter",
    legacyStyle: "Bold",
    weight: 700,
    italic: false,
    variable: false,
    ...overrides,
  };
}

export type RecordedCall = { argv: string[]; env: Record<string, string>; stdin: string | undefined };

/** Records every call and answers with `respond`, which may also throw like a missing executable. */
export function fakeRunner(respond: (call: RecordedCall) => CommandResult = () => ok()) {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (argv, opts = {}) => {
    const call = { argv, env: opts.env ?? {}, stdin: opts.stdin };
    calls.push(call);
    return respond(call);
  };
  return { run, calls };
}

export function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}
