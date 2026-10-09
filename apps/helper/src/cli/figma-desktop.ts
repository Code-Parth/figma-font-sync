import { stat } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../config/paths";

/** Where Figma's installers put the desktop app. Empty on Linux: Figma ships no Linux desktop app. */
export function figmaDesktopCandidates(platform: Platform, home: string, env: Record<string, string | undefined>): string[] {
  switch (platform) {
    case "darwin":
      return ["/Applications/Figma.app", path.posix.join(home, "Applications", "Figma.app")];
    case "win32": {
      // Where the per-user installer from figma.com/downloads puts it.
      const local =
        env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
          ? env.LOCALAPPDATA
          : path.win32.join(home, "AppData", "Local");
      return [path.win32.join(local, "Figma", "Figma.exe")];
    }
    case "linux":
      return [];
  }
}

/** The first candidate that exists, or null. */
export async function findFigmaDesktop(
  platform: Platform,
  home: string,
  env: Record<string, string | undefined>,
  exists: (file: string) => Promise<boolean> = pathExists,
): Promise<string | null> {
  for (const candidate of figmaDesktopCandidates(platform, home, env)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
