import type { FontKey, FontUsage } from "../shared/messages";
import type { ResolvedFont } from "./api/types.gen";

/**
 * What the user can do about one `{family, style}` used in the file.
 *
 * Missing in Figma: "install" (the library has it), "reload" (the file is already on disk but Figma
 * has not reloaded), "replace" (the library's close match is on disk, under a name Figma lists
 * differently), "not-in-library".
 * Available in Figma: "synced" (the library has it), "add" (local file the user may upload),
 * "local-only" (on this machine, not uploadable), "figma-provided" (Google Fonts, Figma-uploaded fonts).
 */
export type FontStatus =
  | "install"
  | "reload"
  | "replace"
  | "not-in-library"
  | "add"
  | "local-only"
  | "synced"
  | "figma-provided";

/** Display order: things that need action first. */
export const STATUS_ORDER: readonly FontStatus[] = [
  "install",
  "reload",
  "replace",
  "not-in-library",
  "add",
  "local-only",
  "synced",
  "figma-provided",
];

export const STATUS_LABEL: Record<FontStatus, string> = {
  install: "Install",
  reload: "Reload tab",
  replace: "Replace font",
  "not-in-library": "Not in library",
  add: "Add to library",
  "local-only": "Local only",
  synced: "Synced",
  "figma-provided": "Provided by Figma",
};

export const STATUS_HINT: Record<FontStatus, string> = {
  install: "Missing in Figma. The library has it.",
  reload: "The font is on this machine, but Figma has not loaded it yet. Reload the file tab.",
  replace:
    "The library's closest font is on this machine, but under a different name. Replace this font in the file with the library's name.",
  "not-in-library": "Missing in Figma, and nobody has added it to the library.",
  add: "Installed on this machine but not in the library. You can add it.",
  "local-only": "Installed on this machine but not in the library.",
  synced: "Available in Figma and in the library.",
  "figma-provided": "Figma provides this font, for example Google Fonts or fonts uploaded to Figma.",
};

export function deriveStatus(usage: FontUsage, resolved: ResolvedFont, canUpload: boolean): FontStatus {
  const { library } = resolved;
  if (!usage.availableInFigma) {
    if (library === null) return "not-in-library";
    if (!resolved.local.installedBySync && !resolved.local.onDisk) return "install";
    // Figma matches {family, style} exactly, so installing a normalized or alias match never makes this key available.
    return library.tier === "exact" ? "reload" : "replace";
  }
  if (library !== null) return "synced";
  if (resolved.local.uploadable && canUpload) return "add";
  if (resolved.local.onDisk) return "local-only";
  return "figma-provided";
}

export function fontKey(font: FontKey): string {
  // NUL cannot appear in a font name, so the key cannot collide.
  return `${font.family}\u0000${font.style}`;
}

export type FontRow = {
  key: string;
  usage: FontUsage;
  resolved: ResolvedFont | null;
  /** null until the helper has resolved the font, or when resolving failed. */
  status: FontStatus | null;
};

export type FontGroup = { family: string; rows: FontRow[] };

function rowRank(row: FontRow): number {
  if (row.status !== null) return STATUS_ORDER.indexOf(row.status);
  return row.usage.availableInFigma ? STATUS_ORDER.length : 0;
}

/** Rows grouped by family; groups with missing fonts first, then by name. */
export function buildFontGroups(fonts: FontUsage[], resolved: ResolvedFont[] | null, canUpload: boolean): FontGroup[] {
  const byKey = new Map<string, ResolvedFont>();
  for (const font of resolved ?? []) byKey.set(fontKey(font), font);

  const groups = new Map<string, FontRow[]>();
  for (const usage of fonts) {
    const key = fontKey(usage);
    const match = byKey.get(key) ?? null;
    const row: FontRow = {
      key,
      usage,
      resolved: match,
      status: match === null ? null : deriveStatus(usage, match, canUpload),
    };
    const rows = groups.get(usage.family);
    if (rows) rows.push(row);
    else groups.set(usage.family, [row]);
  }

  const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const result = [...groups].map(([family, rows]): FontGroup => {
    rows.sort((a, b) => rowRank(a) - rowRank(b) || compareText(a.usage.style, b.usage.style));
    return { family, rows };
  });
  const hasMissing = (group: FontGroup) => group.rows.some((row) => !row.usage.availableInFigma);
  result.sort((a, b) => Number(hasMissing(b)) - Number(hasMissing(a)) || compareText(a.family, b.family));
  return result;
}

export function countStatuses(groups: FontGroup[]): Record<FontStatus, number> {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0])) as Record<FontStatus, number>;
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.status !== null) counts[row.status] += 1;
    }
  }
  return counts;
}

/** Rows the "Install all missing" button covers, and the distinct library files that provide them. */
export function installable(groups: FontGroup[]): { rows: FontRow[]; fileIds: string[] } {
  const rows = groups.flatMap((group) => group.rows.filter((row) => row.status === "install"));
  const fileIds = [...new Set(rows.flatMap((row) => (row.resolved?.library ? [row.resolved.library.fileId] : [])))];
  return { rows, fileIds };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError("chunk size must be at least 1");
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

/** The helper caps one resolve request at 5000 fonts; smaller batches keep each request quick. */
export const RESOLVE_BATCH = 1000;

/**
 * Resolves every font one batch at a time so a huge file does not flood the helper. Only
 * `{family, style}` is sent: a FontUsage also carries page lists the helper does not need.
 */
export async function resolveInBatches(
  fonts: readonly FontKey[],
  resolveBatch: (batch: FontKey[]) => Promise<ResolvedFont[]>,
  size = RESOLVE_BATCH,
): Promise<ResolvedFont[]> {
  const keys = fonts.map(({ family, style }) => ({ family, style }));
  const resolved: ResolvedFont[] = [];
  for (const batch of chunk(keys, size)) resolved.push(...(await resolveBatch(batch)));
  return resolved;
}
