import { createInterface, type Interface } from "node:readline/promises";

/** Questions for `setup` and `uninstall`. */
export interface Prompt {
  /** The answer without surrounding whitespace; `default` when it is empty. */
  ask(question: string, opts?: { default?: string }): Promise<string>;
  /** y/yes or n/no in any case; an empty answer takes the default, anything else asks again. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** Lets go of stdin so the process can exit. */
  close(): void;
}

/** Ctrl+C or end of input while a question was open. */
export class Cancelled extends Error {
  override name = "Cancelled";
  constructor() {
    super("Cancelled.");
  }
}

/**
 * Asks on a terminal. Lines are queued rather than read with rl.question, which drops a line that arrives
 * before the question is asked (a fast typist, a paste of several answers).
 */
export function terminalPrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompt {
  let rl: Interface | null = null;
  let closed = false;
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];

  function open(): Interface {
    if (rl) return rl;
    const created = createInterface({ input, output });
    created.on("line", (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
    created.on("close", () => {
      closed = true;
      for (const next of waiting.splice(0)) next(null);
    });
    // Without a listener readline only pauses on Ctrl+C, which would leave the question hanging.
    created.on("SIGINT", () => {
      output.write("\n");
      created.close();
    });
    rl = created;
    return created;
  }

  async function line(question: string): Promise<string> {
    const current = open();
    if (closed) throw new Cancelled();
    current.setPrompt(question);
    current.prompt();
    const queued = lines.shift();
    const answer = queued ?? (await new Promise<string | null>((resolve) => waiting.push(resolve)));
    if (answer === null) throw new Cancelled();
    return answer.trim();
  }

  return {
    async ask(question, opts = {}) {
      const answer = await line(askText(question, opts.default));
      return answer || (opts.default ?? "");
    },
    async confirm(question, defaultYes) {
      for (;;) {
        const answer = parseYesNo(await line(confirmText(question, defaultYes)));
        if (answer === "default") return defaultYes;
        if (answer !== null) return answer;
        output.write("Answer y or n.\n");
      }
    },
    close() {
      rl?.close();
    },
  };
}

/**
 * Answers every question with its default, for `--yes` and for stdin that is not a terminal. With `out`
 * each question is printed with the answer it got, so a log shows what was decided.
 */
export function defaultsPrompt(out?: (line: string) => void): Prompt {
  return {
    async ask(question, opts = {}) {
      const answer = opts.default ?? "";
      out?.(`${askText(question, opts.default)}${answer}`);
      return answer;
    },
    async confirm(question, defaultYes) {
      out?.(`${confirmText(question, defaultYes)}${defaultYes ? "yes" : "no"}`);
      return defaultYes;
    },
    close() {},
  };
}

function askText(question: string, fallback: string | undefined): string {
  return fallback ? `${question} [${fallback}]: ` : `${question}: `;
}

function confirmText(question: string, defaultYes: boolean): string {
  return `${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `;
}

/** null when the answer is neither yes, no nor empty. */
export function parseYesNo(answer: string): boolean | "default" | null {
  const value = answer.trim().toLowerCase();
  if (value === "") return "default";
  if (value === "y" || value === "yes") return true;
  if (value === "n" || value === "no") return false;
  return null;
}
