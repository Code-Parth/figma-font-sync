import { describe, expect, it } from "bun:test";
import { currentPlatform, resolvePaths } from "../../src/config/paths";

describe("currentPlatform", () => {
  it("maps process.platform", () => {
    expect(currentPlatform()).toBe(process.platform as ReturnType<typeof currentPlatform>);
  });
});

describe("resolvePaths darwin", () => {
  it("uses ~/Library and a flat ~/Library/Fonts", () => {
    expect(resolvePaths("darwin", {}, "/Users/ana")).toEqual({
      configDir: "/Users/ana/Library/Application Support/font-sync",
      cacheDir: "/Users/ana/Library/Caches/font-sync",
      stateDir: "/Users/ana/Library/Application Support/font-sync",
      dataDir: "/Users/ana/Library/Application Support/font-sync",
      installDir: "/Users/ana/Library/Fonts",
      fontDirs: [
        { path: "/Users/ana/Library/Fonts", system: false },
        { path: "/Library/Fonts", system: false },
        { path: "/System/Library/Fonts", system: true },
      ],
    });
  });

  it("ignores XDG variables", () => {
    const paths = resolvePaths("darwin", { XDG_CONFIG_HOME: "/x", XDG_DATA_HOME: "/y" }, "/Users/ana");
    expect(paths.configDir).toBe("/Users/ana/Library/Application Support/font-sync");
    expect(paths.installDir).toBe("/Users/ana/Library/Fonts");
  });
});

describe("resolvePaths win32", () => {
  it("uses APPDATA, LOCALAPPDATA and WINDIR", () => {
    const env = {
      APPDATA: "D:\\Profiles\\ana\\Roaming",
      LOCALAPPDATA: "D:\\Profiles\\ana\\Local",
      WINDIR: "E:\\Win",
    };
    expect(resolvePaths("win32", env, "C:\\Users\\ana")).toEqual({
      configDir: "D:\\Profiles\\ana\\Roaming\\font-sync",
      cacheDir: "D:\\Profiles\\ana\\Local\\font-sync\\cache",
      stateDir: "D:\\Profiles\\ana\\Local\\font-sync",
      dataDir: "D:\\Profiles\\ana\\Local\\font-sync",
      installDir: "D:\\Profiles\\ana\\Local\\Microsoft\\Windows\\Fonts",
      fontDirs: [
        { path: "D:\\Profiles\\ana\\Local\\Microsoft\\Windows\\Fonts", system: false },
        { path: "E:\\Win\\Fonts", system: false },
      ],
    });
  });

  it("falls back to the profile and C:\\Windows", () => {
    expect(resolvePaths("win32", {}, "C:\\Users\\ana")).toEqual({
      configDir: "C:\\Users\\ana\\AppData\\Roaming\\font-sync",
      cacheDir: "C:\\Users\\ana\\AppData\\Local\\font-sync\\cache",
      stateDir: "C:\\Users\\ana\\AppData\\Local\\font-sync",
      dataDir: "C:\\Users\\ana\\AppData\\Local\\font-sync",
      installDir: "C:\\Users\\ana\\AppData\\Local\\Microsoft\\Windows\\Fonts",
      fontDirs: [
        { path: "C:\\Users\\ana\\AppData\\Local\\Microsoft\\Windows\\Fonts", system: false },
        { path: "C:\\Windows\\Fonts", system: false },
      ],
    });
  });

  it("treats empty and relative variables as missing", () => {
    const paths = resolvePaths("win32", { APPDATA: "", LOCALAPPDATA: "relative\\dir" }, "C:\\Users\\ana");
    expect(paths.configDir).toBe("C:\\Users\\ana\\AppData\\Roaming\\font-sync");
    expect(paths.stateDir).toBe("C:\\Users\\ana\\AppData\\Local\\font-sync");
  });
});

describe("resolvePaths linux", () => {
  it("uses XDG variables", () => {
    const env = {
      XDG_CONFIG_HOME: "/cfg",
      XDG_CACHE_HOME: "/cache",
      XDG_STATE_HOME: "/state",
      XDG_DATA_HOME: "/data",
    };
    expect(resolvePaths("linux", env, "/home/ana")).toEqual({
      configDir: "/cfg/font-sync",
      cacheDir: "/cache/font-sync",
      stateDir: "/state/font-sync",
      dataDir: "/data/font-sync",
      installDir: "/data/fonts/font-sync",
      fontDirs: [
        { path: "/data/fonts", system: false },
        { path: "/home/ana/.fonts", system: false },
        { path: "/usr/local/share/fonts", system: false },
        { path: "/usr/share/fonts", system: true },
      ],
    });
  });

  it("falls back to the XDG defaults", () => {
    expect(resolvePaths("linux", {}, "/home/ana")).toEqual({
      configDir: "/home/ana/.config/font-sync",
      cacheDir: "/home/ana/.cache/font-sync",
      stateDir: "/home/ana/.local/state/font-sync",
      dataDir: "/home/ana/.local/share/font-sync",
      installDir: "/home/ana/.local/share/fonts/font-sync",
      fontDirs: [
        { path: "/home/ana/.local/share/fonts", system: false },
        { path: "/home/ana/.fonts", system: false },
        { path: "/usr/local/share/fonts", system: false },
        { path: "/usr/share/fonts", system: true },
      ],
    });
  });

  it("ignores relative XDG values, as the spec requires", () => {
    const paths = resolvePaths("linux", { XDG_DATA_HOME: "share", XDG_CONFIG_HOME: "" }, "/home/ana");
    expect(paths.installDir).toBe("/home/ana/.local/share/fonts/font-sync");
    expect(paths.configDir).toBe("/home/ana/.config/font-sync");
  });
});
