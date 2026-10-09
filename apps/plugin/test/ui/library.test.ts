import { describe, expect, test } from "bun:test";
import type { Face, LibraryFile, Member, UploadResult } from "../../src/ui/api/types.gen";
import {
  batchUploads,
  describeInstall,
  describeUpload,
  describeUploads,
  groupLibraryFiles,
  MAX_BATCH_BYTES,
  MAX_UPLOAD_BYTES,
  memberName,
  memberRoleLabel,
  partitionUploads,
} from "../../src/ui/library";

function face(family: string, style: string): Face {
  return {
    family,
    style,
    postscript: null,
    fullName: null,
    legacyFamily: null,
    legacyStyle: null,
    weight: 400,
    italic: false,
    variable: false,
  };
}

function file(id: string, name: string, faces: Face[], extra: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id,
    name,
    path: "",
    size: 1000,
    md5: id,
    modifiedTime: "2026-10-01T10:00:00Z",
    uploadedBy: null,
    faces,
    parseError: null,
    install: "not-installed",
    canRemove: false,
    ...extra,
  };
}

const files = [
  file("1", "Inter-Bold.ttf", [face("Inter", "Bold")]),
  file("2", "Inter-Regular.ttf", [face("Inter", "Regular")]),
  file("3", "Family.ttc", [face("Zeta", "Light"), face("Alpha", "Book"), face("Alpha", "Book")]),
  file("4", "broken.otf", [], { parseError: "Not an sfnt file" }),
];

describe("groupLibraryFiles", () => {
  test("groups by family, alphabetically, with unreadable files last", () => {
    const groups = groupLibraryFiles(files, "");
    expect(groups.map((group) => group.family)).toEqual(["Alpha", "Inter", "Zeta", null]);
    expect(groups[1]?.entries.map((entry) => entry.file.name)).toEqual(["Inter-Bold.ttf", "Inter-Regular.ttf"]);
  });

  test("a collection appears under each family with only that family's styles, deduped", () => {
    const groups = groupLibraryFiles(files, "");
    expect(groups.find((group) => group.family === "Alpha")?.entries[0]?.styles).toEqual(["Book"]);
    expect(groups.find((group) => group.family === "Zeta")?.entries[0]?.styles).toEqual(["Light"]);
  });

  test("search matches family, style or file name, ignoring case", () => {
    expect(groupLibraryFiles(files, "inter").map((group) => group.family)).toEqual(["Inter"]);
    expect(groupLibraryFiles(files, "BOLD").flatMap((group) => group.entries.map((entry) => entry.file.id))).toEqual([
      "1",
    ]);
    expect(groupLibraryFiles(files, "family.ttc").map((group) => group.family)).toEqual(["Alpha", "Zeta"]);
    expect(groupLibraryFiles(files, "broken").map((group) => group.family)).toEqual([null]);
    expect(groupLibraryFiles(files, "  light ").map((group) => group.family)).toEqual(["Zeta"]);
    expect(groupLibraryFiles(files, "nothing")).toEqual([]);
  });
});

describe("members", () => {
  const member = (overrides: Partial<Member>): Member => ({
    email: "a@example.com",
    name: null,
    role: "reader",
    type: "user",
    ...overrides,
  });

  test("role labels say what the person can do", () => {
    expect(memberRoleLabel("owner")).toBe("Owner");
    expect(memberRoleLabel("writer")).toBe("Can add fonts");
    expect(memberRoleLabel("organizer")).toBe("Can add fonts");
    expect(memberRoleLabel("fileOrganizer")).toBe("Can add fonts");
    expect(memberRoleLabel("commenter")).toBe("Can install");
    expect(memberRoleLabel("reader")).toBe("Can install");
  });

  test("names prefer the display name, then email", () => {
    expect(memberName(member({ name: "Ada" }))).toBe("Ada");
    expect(memberName(member({}))).toBe("a@example.com");
    expect(memberName(member({ type: "anyone", email: null }))).toBe("Anyone with the link");
    expect(memberName(member({ type: "domain", email: null }))).toBe("Everyone in a domain");
    expect(memberName(member({ email: null }))).toBe("Unknown account");
  });
});

describe("partitionUploads", () => {
  test("accepts sfnt extensions in any case and refuses others or oversized files", () => {
    const { accepted, rejected } = partitionUploads([
      { name: "a.ttf", size: 10 },
      { name: "b.OTF", size: 10 },
      { name: "c.ttc", size: 10 },
      { name: "d.otc", size: 10 },
      { name: "e.woff2", size: 10 },
      { name: "f.ttf", size: MAX_UPLOAD_BYTES + 1 },
      { name: "ttf", size: 10 },
    ]);
    expect(accepted.map((entry) => entry.name)).toEqual(["a.ttf", "b.OTF", "c.ttc", "d.otc"]);
    expect(rejected.map((entry) => [entry.file.name, entry.reason])).toEqual([
      ["e.woff2", "Not a .ttf, .otf, .ttc or .otc file."],
      ["f.ttf", "Larger than 50 MB."],
      ["ttf", "Not a .ttf, .otf, .ttc or .otc file."],
    ]);
  });
});

describe("batchUploads", () => {
  const MB = 1024 * 1024;

  test("splits files that each pass the size check but together exceed the request limit, keeping order", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({ name: `cjk-${index}.otf`, size: 15 * MB }));
    const batches = batchUploads(files);
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      expect(batch.reduce((total, file) => total + file.size, 0)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    expect(batches.flat().map((file) => file.name)).toEqual(files.map((file) => file.name));
  });

  test("files at the upload limit go two per request; small ones share one", () => {
    const large = Array.from({ length: 3 }, () => ({ size: MAX_UPLOAD_BYTES }));
    expect(batchUploads(large).map((batch) => batch.length)).toEqual([2, 1]);
    expect(batchUploads([{ size: 10 }, { size: 20 }, { size: 30 }]).map((batch) => batch.length)).toEqual([3]);
  });

  test("makes no request for no files", () => {
    expect(batchUploads([])).toEqual([]);
  });
});

describe("upload outcomes", () => {
  const result = (overrides: Partial<UploadResult>): UploadResult => ({
    name: "Inter-Bold.ttf",
    ok: true,
    fileId: "new",
    duplicateOf: null,
    error: null,
    faces: [face("Inter", "Bold")],
    ...overrides,
  });
  const nameOf = (id: string) => (id === "1" ? "Inter-Bold.ttf" : undefined);

  test("added files list their families and style count", () => {
    expect(describeUpload(result({}), nameOf)).toEqual({ tone: "success", text: "Added Inter (1 style)." });
    expect(
      describeUpload(result({ faces: [face("Inter", "Bold"), face("Inter", "Black"), face("Mono", "Regular")] }), nameOf),
    ).toEqual({ tone: "success", text: "Added Inter, Mono (3 styles)." });
  });

  test("duplicates name the existing file when known", () => {
    expect(describeUpload(result({ duplicateOf: "1", fileId: null }), nameOf)).toEqual({
      tone: "neutral",
      text: "Already in the library as Inter-Bold.ttf.",
    });
    expect(describeUpload(result({ ok: false, duplicateOf: "9" }), nameOf).text).toBe("Already in the library.");
  });

  test("failures show the helper's reason", () => {
    expect(describeUpload(result({ ok: false, error: "WOFF2 is not installable", faces: [] }), nameOf)).toEqual({
      tone: "danger",
      text: "WOFF2 is not installable",
    });
    expect(describeUpload(result({ ok: false, error: null, faces: [] }), nameOf).text).toBe("Could not add this file.");
  });

  test("describeUploads prefixes the file name", () => {
    expect(describeUploads([result({})], nameOf)[0]?.text).toBe("Inter-Bold.ttf: Added Inter (1 style).");
  });
});

describe("describeInstall", () => {
  test("summarises successes and the first failure", () => {
    expect(describeInstall("install", [{ fileId: "a", ok: true, error: null }])).toBe("Installed 1 file.");
    expect(
      describeInstall("uninstall", [
        { fileId: "a", ok: true, error: null },
        { fileId: "b", ok: true, error: null },
      ]),
    ).toBe("Uninstalled 2 files.");
    expect(
      describeInstall("install", [
        { fileId: "a", ok: true, error: null },
        { fileId: "b", ok: false, error: "Disk full" },
        { fileId: "c", ok: false, error: "Locked" },
      ]),
    ).toBe("Installed 1 file. 2 files failed: Disk full");
    expect(describeInstall("install", [{ fileId: "a", ok: false, error: null }])).toBe("1 file failed.");
    expect(describeInstall("install", [])).toBe("Nothing to do.");
  });
});
