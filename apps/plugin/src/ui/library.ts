import type { FileResult, LibraryFile, Member, Role, UploadResult } from "./api/types.gen";
import { plural } from "./format";

export const FONT_EXTENSIONS = [".ttf", ".otf", ".ttc", ".otc"] as const;
/** Matches the helper's upload limit, checked here so a huge file is not sent only to be refused. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/**
 * Bun refuses request bodies over 128 MiB before the helper sees them, with a 413 that has no CORS
 * header, so the plugin can only report "can't reach the helper". This leaves room for multipart overhead.
 */
export const MAX_BATCH_BYTES = 100 * 1024 * 1024;

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

export type LibraryEntry = { file: LibraryFile; styles: string[] };
/** `family` is null for files whose faces could not be read. */
export type LibraryGroup = { family: string | null; entries: LibraryEntry[] };

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * Groups library files by family. A collection or a file with several families appears under each
 * of them, listing only that family's styles. `search` matches family, style or file name.
 */
export function groupLibraryFiles(files: readonly LibraryFile[], search: string): LibraryGroup[] {
  const needle = search.trim().toLocaleLowerCase();
  const includes = (text: string) => text.toLocaleLowerCase().includes(needle);
  const groups = new Map<string | null, LibraryEntry[]>();
  const add = (family: string | null, entry: LibraryEntry) => {
    const entries = groups.get(family);
    if (entries) entries.push(entry);
    else groups.set(family, [entry]);
  };

  for (const file of files) {
    if (file.faces.length === 0) {
      if (!needle || includes(file.name)) add(null, { file, styles: [] });
      continue;
    }
    const stylesByFamily = new Map<string, Set<string>>();
    for (const face of file.faces) {
      const styles = stylesByFamily.get(face.family) ?? new Set<string>();
      styles.add(face.style);
      stylesByFamily.set(face.family, styles);
    }
    for (const [family, styleSet] of stylesByFamily) {
      const styles = [...styleSet];
      if (needle && !includes(family) && !includes(file.name) && !styles.some(includes)) continue;
      add(family, { file, styles });
    }
  }

  const result = [...groups].map(([family, entries]): LibraryGroup => {
    entries.sort((a, b) => compareText(a.file.name, b.file.name));
    return { family, entries };
  });
  // Unreadable files go last; they need attention from whoever uploaded them, not from everyone.
  result.sort((a, b) => {
    if (a.family === null || b.family === null) return Number(a.family === null) - Number(b.family === null);
    return compareText(a.family, b.family);
  });
  return result;
}

export function memberRoleLabel(role: Member["role"]): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "organizer":
    case "fileOrganizer":
    case "writer":
      return "Can add fonts";
    case "commenter":
    case "reader":
      return "Can install";
  }
}

export function memberName(member: Member): string {
  if (member.type === "anyone") return "Anyone with the link";
  const name = member.name ?? member.email;
  if (name) return name;
  return member.type === "domain" ? "Everyone in a domain" : "Unknown account";
}

export type Rejected<T> = { file: T; reason: string };

/** Splits picked or dropped files into ones worth sending and ones refused with a reason. */
export function partitionUploads<T extends { name: string; size: number }>(
  files: readonly T[],
): { accepted: T[]; rejected: Rejected<T>[] } {
  const accepted: T[] = [];
  const rejected: Rejected<T>[] = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (!FONT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      rejected.push({ file, reason: "Not a .ttf, .otf, .ttc or .otc file." });
    } else if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({ file, reason: "Larger than 50 MB." });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

/**
 * Splits accepted files into upload requests of at most MAX_BATCH_BYTES, keeping their order. A file
 * larger than the limit on its own still gets a request, but partitionUploads has refused those.
 */
export function batchUploads<T extends { size: number }>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const file of files) {
    if (batch.length > 0 && bytes + file.size > MAX_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export type Outcome = { tone: "success" | "neutral" | "danger"; text: string };

/** One line per uploaded or published file. `nameOf` turns a library file id into its file name. */
export function describeUpload(result: UploadResult, nameOf: (fileId: string) => string | undefined): Outcome {
  if (result.duplicateOf !== null) {
    const existing = nameOf(result.duplicateOf);
    return { tone: "neutral", text: existing ? `Already in the library as ${existing}.` : "Already in the library." };
  }
  if (!result.ok) return { tone: "danger", text: result.error ?? "Could not add this file." };
  const families = [...new Set(result.faces.map((face) => face.family))];
  const styles = result.faces.length === 1 ? "1 style" : `${result.faces.length} styles`;
  return { tone: "success", text: families.length > 0 ? `Added ${families.join(", ")} (${styles}).` : "Added." };
}

export type InstallAction = "install" | "uninstall";

/** One sentence for the live region after an install or uninstall. */
export function describeInstall(action: InstallAction, results: readonly FileResult[]): string {
  const failures = results.filter((result) => !result.ok);
  const done = results.length - failures.length;
  const parts: string[] = [];
  if (done > 0) parts.push(`${action === "install" ? "Installed" : "Uninstalled"} ${plural(done, "file")}.`);
  const first = failures[0];
  if (first !== undefined) {
    const reason = first.error ? `: ${first.error}` : ".";
    parts.push(`${plural(failures.length, "file")} failed${reason}`);
  }
  return parts.length > 0 ? parts.join(" ") : "Nothing to do.";
}

/** Outcome lines prefixed with the file or font name, for upload and publish results. */
export function describeUploads(
  results: readonly UploadResult[],
  nameOf: (fileId: string) => string | undefined,
): Outcome[] {
  return results.map((result) => {
    const outcome = describeUpload(result, nameOf);
    return { ...outcome, text: `${result.name}: ${outcome.text}` };
  });
}
