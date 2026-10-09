import { describe, expect, test } from "bun:test";
import { detectPlatform, isFigmaDesktop } from "../../src/ui/platform";

// Figma desktop 126.9.11 keeps Electron's default user agent and appends an installer or arch token.
const FIGMA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Figma/126.9.11 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36";
const FIGMA_MAC_ARM = `${FIGMA_MAC} FigmaARM`;
const FIGMA_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Figma/126.9.11 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36";
const FIGMA_WINDOWS_MSI = `${FIGMA_WINDOWS} FigmaMSI`;
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
/** Synthetic: an unofficial Electron wrapper on Linux, the only way to run desktop-style Figma there. */
const ELECTRON_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36";

describe("detectPlatform", () => {
  test("Figma desktop on macOS, Intel and Apple silicon alike", () => {
    expect(detectPlatform(FIGMA_MAC)).toBe("mac");
    expect(detectPlatform(FIGMA_MAC_ARM)).toBe("mac");
  });

  test("Figma desktop on Windows", () => {
    expect(detectPlatform(FIGMA_WINDOWS)).toBe("windows");
    expect(detectPlatform(FIGMA_WINDOWS_MSI)).toBe("windows");
  });

  test("a browser still reports its OS", () => {
    expect(detectPlatform(CHROME_MAC)).toBe("mac");
    expect(detectPlatform(CHROME_WINDOWS)).toBe("windows");
  });

  test("anything else is other", () => {
    expect(detectPlatform(CHROME_LINUX)).toBe("other");
    expect(detectPlatform(ELECTRON_LINUX)).toBe("other");
    expect(detectPlatform("")).toBe("other");
  });
});

describe("isFigmaDesktop", () => {
  test("true with an Electron token", () => {
    expect(isFigmaDesktop(FIGMA_MAC)).toBe(true);
    expect(isFigmaDesktop(FIGMA_MAC_ARM)).toBe(true);
    expect(isFigmaDesktop(FIGMA_WINDOWS)).toBe(true);
    expect(isFigmaDesktop(FIGMA_WINDOWS_MSI)).toBe(true);
  });

  test("false in a plain browser", () => {
    expect(isFigmaDesktop(CHROME_MAC)).toBe(false);
    expect(isFigmaDesktop(CHROME_WINDOWS)).toBe(false);
    expect(isFigmaDesktop(CHROME_LINUX)).toBe(false);
    expect(isFigmaDesktop("")).toBe(false);
  });

  test("a token that only ends in Electron does not count", () => {
    expect(isFigmaDesktop(`${CHROME_MAC} NotElectron/1.0`)).toBe(false);
  });
});
