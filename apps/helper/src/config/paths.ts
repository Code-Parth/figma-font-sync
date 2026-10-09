import path from "node:path";

export type Platform = "darwin" | "win32" | "linux";

export type Paths = {
  /** config.json, and credentials.json when the OS secret store is unavailable. */
  configDir: string;
  /** library-faces.json and local-fonts.json; safe to delete. */
  cacheDir: string;
  /** installed.json. */
  stateDir: string;
  /** Where Font Sync writes font files it installs. */
  installDir: string;
  /** Directories scanned for fonts already on this machine. `system` faces are never offered for upload. */
  fontDirs: { path: string; system: boolean }[];
};

const APP = "font-sync";

export function currentPlatform(): Platform {
  const platform = process.platform;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  throw new Error(`Font Sync does not support ${platform}`);
}

/** Pure: no filesystem access, so every platform can be tested from any OS. */
export function resolvePaths(platform: Platform, env: Record<string, string | undefined>, home: string): Paths {
  switch (platform) {
    case "darwin": {
      const { join } = path.posix;
      const configDir = join(home, "Library", "Application Support", APP);
      // Flat in ~/Library/Fonts: whether CoreText activates fonts in a subfolder is unverified.
      const installDir = join(home, "Library", "Fonts");
      return {
        configDir,
        cacheDir: join(home, "Library", "Caches", APP),
        stateDir: configDir,
        installDir,
        fontDirs: [
          { path: installDir, system: false },
          { path: "/Library/Fonts", system: false },
          { path: "/System/Library/Fonts", system: true },
        ],
      };
    }
    case "win32": {
      const { join } = path.win32;
      const roaming = envDir(env.APPDATA, path.win32) ?? join(home, "AppData", "Roaming");
      const local = envDir(env.LOCALAPPDATA, path.win32) ?? join(home, "AppData", "Local");
      const windows = envDir(env.WINDIR, path.win32) ?? envDir(env.SystemRoot, path.win32) ?? "C:\\Windows";
      const stateDir = join(local, APP);
      const installDir = join(local, "Microsoft", "Windows", "Fonts");
      return {
        configDir: join(roaming, APP),
        cacheDir: join(stateDir, "cache"),
        stateDir,
        installDir,
        fontDirs: [
          { path: installDir, system: false },
          // Not system: teams often install shared fonts for all users, and those should be uploadable.
          { path: join(windows, "Fonts"), system: false },
        ],
      };
    }
    case "linux": {
      const { join } = path.posix;
      const config = envDir(env.XDG_CONFIG_HOME, path.posix) ?? join(home, ".config");
      const cache = envDir(env.XDG_CACHE_HOME, path.posix) ?? join(home, ".cache");
      const state = envDir(env.XDG_STATE_HOME, path.posix) ?? join(home, ".local", "state");
      const data = envDir(env.XDG_DATA_HOME, path.posix) ?? join(home, ".local", "share");
      const userFonts = join(data, "fonts");
      return {
        configDir: join(config, APP),
        cacheDir: join(cache, APP),
        stateDir: join(state, APP),
        // fontconfig recurses into subdirectories, so our own folder keeps uninstall and scans simple.
        installDir: join(userFonts, APP),
        fontDirs: [
          { path: userFonts, system: false },
          { path: join(home, ".fonts"), system: false },
          { path: "/usr/local/share/fonts", system: false },
          { path: "/usr/share/fonts", system: true },
        ],
      };
    }
  }
}

/** The XDG spec says relative values are invalid and must be ignored; the same rule keeps Windows sane. */
function envDir(value: string | undefined, flavor: typeof path.posix): string | undefined {
  return value && flavor.isAbsolute(value) ? value : undefined;
}
