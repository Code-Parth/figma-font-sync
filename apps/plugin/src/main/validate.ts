// Checks everything that reaches the main thread from outside it: UI messages and clientStorage values.
// No figma globals here, so it runs under bun:test.

import type { FontKey, Prefs, ScanOptions, UiToMain } from "../shared/messages";

export const DEFAULT_PREFS: Prefs = { scope: "document", deep: false };

export const UI_WIDTH = { min: 320, max: 800 };
export const UI_HEIGHT = { min: 400, max: 1000 };

// The trailing slash matters: it ends the host, so "https://drive.google.com.evil.example/" fails.
const OPENABLE_PREFIXES = ["https://drive.google.com/", "https://docs.google.com/"];

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is ScanOptions["scope"] {
  return value === "page" || value === "document";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseScanOptions(value: unknown): ScanOptions | null {
  if (!isFields(value) || !isScope(value.scope) || typeof value.deep !== "boolean") return null;
  return { scope: value.scope, deep: value.deep };
}

function parseFontKey(value: unknown): FontKey | null {
  if (!isFields(value) || typeof value.family !== "string" || typeof value.style !== "string") return null;
  return { family: value.family, style: value.style };
}

/** Returns null for anything that is not exactly one of the UiToMain shapes. Unknown extra fields are dropped. */
export function parseUiMessage(raw: unknown): UiToMain | null {
  if (!isFields(raw)) return null;
  switch (raw.type) {
    case "scan": {
      const options = parseScanOptions(raw.options);
      return options ? { type: "scan", options } : null;
    }
    case "select-font": {
      const font = parseFontKey(raw.font);
      return font ? { type: "select-font", font } : null;
    }
    case "save-token":
      return raw.token === null || typeof raw.token === "string" ? { type: "save-token", token: raw.token } : null;
    case "save-prefs": {
      const prefs = parseScanOptions(raw.prefs);
      return prefs ? { type: "save-prefs", prefs } : null;
    }
    case "open-external":
      return typeof raw.url === "string" ? { type: "open-external", url: raw.url } : null;
    case "notify":
      if (typeof raw.message !== "string") return null;
      if (raw.error === undefined) return { type: "notify", message: raw.message };
      return typeof raw.error === "boolean" ? { type: "notify", message: raw.message, error: raw.error } : null;
    case "resize":
      return isFiniteNumber(raw.width) && isFiniteNumber(raw.height)
        ? { type: "resize", width: raw.width, height: raw.height }
        : null;
    default:
      return null;
  }
}

/**
 * Stored prefs, field by field: a value written by an older build keeps whatever is still valid
 * and takes the default for the rest.
 */
export function parsePrefs(value: unknown): Prefs {
  const fields = isFields(value) ? value : {};
  return {
    scope: isScope(fields.scope) ? fields.scope : DEFAULT_PREFS.scope,
    deep: typeof fields.deep === "boolean" ? fields.deep : DEFAULT_PREFS.deep,
  };
}

export function parseStoredToken(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function isOpenableUrl(url: string): boolean {
  return OPENABLE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function clampUiSize(width: number, height: number): { width: number; height: number } {
  return {
    width: clamp(Math.round(width), UI_WIDTH.min, UI_WIDTH.max),
    height: clamp(Math.round(height), UI_HEIGHT.min, UI_HEIGHT.max),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
