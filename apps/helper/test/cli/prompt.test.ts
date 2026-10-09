import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { Cancelled, defaultsPrompt, parseYesNo, terminalPrompt } from "../../src/cli/prompt";

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  const prompt = terminalPrompt(input, output);
  return { input, prompt, written: () => written };
}

describe("terminalPrompt", () => {
  it("returns the trimmed answer, or the default for an empty one", async () => {
    const { input, prompt, written } = terminal();
    const name = prompt.ask("Client id");
    input.write("  123-abc  \n");
    expect(await name).toBe("123-abc");
    const port = prompt.ask("Port", { default: "47321" });
    input.write("\n");
    expect(await port).toBe("47321");
    prompt.close();
    expect(written()).toBe("Client id: Port [47321]: ");
  });

  it("reads yes and no in any case, takes the default on Enter and asks again otherwise", async () => {
    const { input, prompt, written } = terminal();
    const answers: boolean[] = [];
    for (const [line, defaultYes] of [
      ["Y", false],
      ["no", true],
      ["", true],
      ["", false],
    ] as const) {
      const answer = prompt.confirm("Go on?", defaultYes);
      input.write(`${line}\n`);
      answers.push(await answer);
    }
    expect(answers).toEqual([true, false, true, false]);

    const retried = prompt.confirm("Really?", true);
    input.write("maybe\n");
    await Bun.sleep(5);
    input.write("yes\n");
    expect(await retried).toBe(true);
    expect(written()).toContain("Really? [Y/n] Answer y or n.\nReally? [Y/n] ");
    prompt.close();
  });

  it("keeps lines that arrive before the question, such as a pasted block", async () => {
    const { input, prompt } = terminal();
    // Opens the interface, so the paste below is read while no question is pending.
    const first = prompt.ask("First");
    input.write("one\ntwo\n");
    expect(await first).toBe("one");
    await Bun.sleep(5);
    expect(await prompt.ask("Second")).toBe("two");
    prompt.close();
  });

  it("cancels an open question when input ends", async () => {
    const { input, prompt } = terminal();
    const answer = prompt.ask("Client id");
    input.end();
    await expect(answer).rejects.toBeInstanceOf(Cancelled);
    await expect(prompt.ask("Again")).rejects.toBeInstanceOf(Cancelled);
  });
});

describe("defaultsPrompt", () => {
  it("answers with the defaults and prints what it decided", async () => {
    const out: string[] = [];
    const prompt = defaultsPrompt((line) => out.push(line));
    expect(await prompt.confirm("Start at login?", true)).toBe(true);
    expect(await prompt.confirm("Delete everything?", false)).toBe(false);
    expect(await prompt.ask("Port", { default: "47321" })).toBe("47321");
    expect(await prompt.ask("Client id")).toBe("");
    prompt.close();
    expect(out).toEqual(["Start at login? [Y/n] yes", "Delete everything? [y/N] no", "Port [47321]: 47321", "Client id: "]);
  });
});

describe("parseYesNo", () => {
  it.each([
    ["y", true],
    ["YES", true],
    [" n ", false],
    ["No", false],
    ["", "default"],
    ["  ", "default"],
    ["yep", null],
    ["0", null],
  ] as const)("reads %p", (answer, expected) => {
    expect(parseYesNo(answer)).toBe(expected);
  });
});
