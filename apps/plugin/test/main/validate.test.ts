import { describe, expect, test } from "bun:test";
import {
  clampUiSize,
  DEFAULT_PREFS,
  isOpenableUrl,
  parsePrefs,
  parseStoredToken,
  parseUiMessage,
} from "../../src/main/validate";

describe("parseUiMessage", () => {
  test("accepts every UiToMain shape", () => {
    const valid = [
      { type: "scan", options: { scope: "page", deep: true } },
      { type: "scan", options: { scope: "document", deep: false } },
      { type: "select-font", font: { family: "Inter", style: "Bold" } },
      { type: "save-token", token: "abc" },
      { type: "save-token", token: null },
      { type: "save-prefs", prefs: { scope: "page", deep: false } },
      { type: "open-external", url: "https://drive.google.com/drive/folders/x" },
      { type: "notify", message: "Installed" },
      { type: "notify", message: "Failed", error: true },
      { type: "resize", width: 500, height: 700 },
    ];
    for (const message of valid) expect<unknown>(parseUiMessage(message)).toEqual(message);
  });

  test("drops fields the protocol does not define", () => {
    expect(parseUiMessage({ type: "select-font", font: { family: "Inter", style: "Bold", extra: 1 }, junk: true })).toEqual(
      { type: "select-font", font: { family: "Inter", style: "Bold" } },
    );
    expect(parseUiMessage({ type: "scan", options: { scope: "page", deep: false, all: true } })).toEqual({
      type: "scan",
      options: { scope: "page", deep: false },
    });
  });

  test.each([
    ["null", null],
    ["a string", "scan"],
    ["an array", [{ type: "scan" }]],
    ["no type", { options: { scope: "page", deep: false } }],
    ["an unknown type", { type: "install", font: { family: "Inter", style: "Bold" } }],
    ["scan without options", { type: "scan" }],
    ["scan with a bad scope", { type: "scan", options: { scope: "selection", deep: false } }],
    ["scan with a non-boolean deep", { type: "scan", options: { scope: "page", deep: "yes" } }],
    ["select-font without a style", { type: "select-font", font: { family: "Inter" } }],
    ["select-font with a numeric family", { type: "select-font", font: { family: 1, style: "Bold" } }],
    ["save-token with a number", { type: "save-token", token: 42 }],
    ["save-token with no token", { type: "save-token" }],
    ["save-prefs with partial prefs", { type: "save-prefs", prefs: { scope: "page" } }],
    ["open-external without a url", { type: "open-external" }],
    ["notify with an object message", { type: "notify", message: { text: "hi" } }],
    ["notify with a string error flag", { type: "notify", message: "hi", error: "true" }],
    ["resize with strings", { type: "resize", width: "500", height: "700" }],
    ["resize with NaN", { type: "resize", width: Number.NaN, height: 700 }],
    ["resize with Infinity", { type: "resize", width: 500, height: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_label, raw) => {
    expect(parseUiMessage(raw)).toBeNull();
  });
});

describe("parsePrefs", () => {
  test("defaults to the whole document, shallow", () => {
    expect(DEFAULT_PREFS).toEqual({ scope: "document", deep: false });
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("page")).toEqual(DEFAULT_PREFS);
  });

  test("keeps valid fields and defaults the rest", () => {
    expect(parsePrefs({ scope: "page", deep: true })).toEqual({ scope: "page", deep: true });
    expect(parsePrefs({ scope: "page" })).toEqual({ scope: "page", deep: false });
    expect(parsePrefs({ scope: "everything", deep: true })).toEqual({ scope: "document", deep: true });
    expect(parsePrefs({ scope: "page", deep: 1, extra: true })).toEqual({ scope: "page", deep: false });
  });

  test("returns a fresh object each time, so callers cannot mutate the default", () => {
    const prefs = parsePrefs(undefined);
    prefs.deep = true;
    expect(DEFAULT_PREFS.deep).toBe(false);
  });
});

describe("parseStoredToken", () => {
  test("a non-empty string is a token; anything else is none", () => {
    expect(parseStoredToken("t0k3n")).toBe("t0k3n");
    expect(parseStoredToken("")).toBeNull();
    expect(parseStoredToken(undefined)).toBeNull();
    expect(parseStoredToken(null)).toBeNull();
    expect(parseStoredToken({ token: "x" })).toBeNull();
  });
});

describe("isOpenableUrl", () => {
  test.each([
    "https://drive.google.com/",
    "https://drive.google.com/drive/folders/1AbC",
    "https://docs.google.com/document/d/1AbC/edit",
  ])("opens %s", (url) => {
    expect(isOpenableUrl(url)).toBe(true);
  });

  test.each([
    "https://drive.google.com",
    "http://drive.google.com/drive/folders/1AbC",
    "https://drive.google.com.evil.example/",
    "https://drive.google.com@evil.example/",
    "https://evil.example/https://drive.google.com/",
    "HTTPS://DRIVE.GOOGLE.COM/",
    "https://mail.google.com/",
    "javascript:alert(1)//https://drive.google.com/",
    " https://drive.google.com/",
    "",
  ])("refuses %s", (url) => {
    expect(isOpenableUrl(url)).toBe(false);
  });
});

describe("clampUiSize", () => {
  test("keeps sizes inside 320..800 by 400..1000", () => {
    expect(clampUiSize(400, 620)).toEqual({ width: 400, height: 620 });
    expect(clampUiSize(100, 100)).toEqual({ width: 320, height: 400 });
    expect(clampUiSize(5000, 5000)).toEqual({ width: 800, height: 1000 });
    expect(clampUiSize(-20, 0)).toEqual({ width: 320, height: 400 });
    expect(clampUiSize(320, 1000)).toEqual({ width: 320, height: 1000 });
  });

  test("rounds to whole pixels", () => {
    expect(clampUiSize(500.4, 700.6)).toEqual({ width: 500, height: 701 });
  });
});
