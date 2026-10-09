import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Unreachable } from "../../src/ui/screens/Unreachable";

const FIGMA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Figma/126.9.11 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36";
const FIGMA_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Figma/126.9.11 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36";
const FIGMA_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Figma/126.9.11 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function render({ paired, userAgent, checking = false }: { paired: boolean; userAgent: string; checking?: boolean }) {
  const html = renderToStaticMarkup(
    <Unreachable paired={paired} checking={checking} onCheck={() => {}} userAgent={userAgent} />,
  );
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const commands = [...html.matchAll(/<code[^>]*>([^<]*)<\/code>/g)].map((match) => match[1]);
  const copyButtons = html.match(/>Copy<\/button>/g)?.length ?? 0;
  return { html, text, commands, copyButtons };
}

describe("Unreachable", () => {
  test("Figma in a browser: only says the desktop app is needed", () => {
    for (const paired of [true, false]) {
      const { text, commands, html } = render({ paired, userAgent: CHROME_MAC });
      expect(text).toContain("Figma desktop app");
      expect(commands).toEqual([]);
      expect(text).not.toContain("Check now");
      expect(html).not.toContain("<button");
    }
  });

  test("paired before on macOS: start at login first, since it starts the helper too, then start for this once", () => {
    const { text, commands, copyButtons } = render({ paired: true, userAgent: FIGMA_MAC });
    expect(text).toContain("Start the Font Sync helper");
    expect(text).toContain("Open Terminal and run:");
    expect(commands).toEqual(["figma-font-sync autostart enable", "figma-font-sync start"]);
    expect(text).toContain("That starts it now and every time you log in. To start it only this once instead:");
    expect(copyButtons).toBe(2);
    expect(text).toContain("This screen moves on by itself as soon as the helper answers.");
    expect(text).toContain("Check now");
  });

  test("paired before on Linux: the same order as macOS, since systemd starts the unit on enable", () => {
    const { text, commands } = render({ paired: true, userAgent: FIGMA_LINUX });
    expect(text).toContain("Open a terminal and run:");
    expect(commands).toEqual(["figma-font-sync autostart enable", "figma-font-sync start"]);
  });

  test("paired before on Windows: start first, since the Run key starts nothing until the next login", () => {
    const { text, commands } = render({ paired: true, userAgent: FIGMA_WINDOWS });
    expect(text).toContain("Open Command Prompt and run:");
    expect(text).toContain("PowerShell");
    expect(commands).toEqual(["figma-font-sync start", "figma-font-sync.cmd start", "figma-font-sync autostart enable"]);
    expect(text).toContain("To start it every time you log in (in PowerShell, figma-font-sync.cmd");
    expect(text).not.toContain("starts it now");
  });

  test("never paired on macOS: npm install, setup, and the curl installer as the alternative", () => {
    const { text, commands, copyButtons } = render({ paired: false, userAgent: FIGMA_MAC });
    expect(text).toContain("Install Font Sync");
    expect(text).toContain("Open Terminal and run:");
    expect(commands).toEqual([
      "npm i -g figma-font-sync",
      "figma-font-sync setup",
      "curl -fsSL https://unpkg.com/figma-font-sync/install.sh | sh",
    ]);
    expect(copyButtons).toBe(3);
    expect(text).toContain("This screen moves on by itself as soon as the helper answers.");
  });

  test("never paired on Windows: no curl line, and the PowerShell .cmd note", () => {
    const { text, commands } = render({ paired: false, userAgent: FIGMA_WINDOWS });
    expect(text).toContain("Open Command Prompt and run:");
    expect(commands).toEqual(["npm i -g figma-font-sync", "figma-font-sync setup"]);
    expect(text).toContain("npm.cmd");
    expect(text).toContain("figma-font-sync.cmd");
  });

  test("Check now stays enabled while a check runs, so keyboard focus survives the poll", () => {
    const { html, text } = render({ paired: true, userAgent: FIGMA_MAC, checking: true });
    expect(text).toContain("Checking...");
    expect(html).not.toContain("disabled");
  });

  test("never the old font-sync command name, and no dashes the copy rules ban", () => {
    for (const paired of [true, false]) {
      for (const userAgent of [FIGMA_MAC, FIGMA_WINDOWS, FIGMA_LINUX, CHROME_MAC]) {
        const { text } = render({ paired, userAgent });
        expect(text).not.toMatch(/(^|[^-])font-sync (serve|start|setup|autostart)/);
        expect(text).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  test("each copy button is described by its command", () => {
    const { html } = render({ paired: true, userAgent: FIGMA_MAC });
    const ids = [...html.matchAll(/<code id="([^"]+)"/g)].map((match) => match[1]);
    const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(described).toEqual(ids);
  });
});
