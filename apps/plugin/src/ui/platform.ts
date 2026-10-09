export type Platform = "mac" | "windows" | "other";

/**
 * Chromium freezes the platform token, so every Mac (Apple silicon too) reports "Macintosh; Intel Mac OS X
 * 10_15_7" and every Windows machine "Windows NT 10.0; Win64; x64". That is still enough to name the right
 * terminal app.
 */
export function detectPlatform(userAgent: string): Platform {
  if (/Windows/.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  return "other";
}

/** Figma desktop keeps Electron's default user agent; Figma in a browser has no Electron token. */
export function isFigmaDesktop(userAgent: string): boolean {
  return /\bElectron\//.test(userAgent);
}
