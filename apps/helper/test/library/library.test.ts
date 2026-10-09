import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperError } from "../../src/errors";
import type { LocalFace } from "../../src/fonts/local-scan";
import { MAX_FONT_BYTES, parseFont } from "../../src/fonts/sfnt";
import type { Face } from "../../src/fonts/types";
import { GoogleApiError } from "../../src/google/drive";
import { INDEX_FILE_NAME, LIBRARY_FOLDER_NAME, type SharedIndex } from "../../src/library/library";
import { buildCollection, buildFont } from "../support/font-builder";
import { EDITOR_FOLDER, OTHER, VIEWER_FOLDER, caps, md5, setup } from "./support";

const INTER_BOLD = buildFont({ names: { 1: "Inter", 2: "Bold", 4: "Inter Bold", 6: "Inter-Bold" }, weight: 700 });
const INTER_BOLD_V2 = buildFont({
  names: { 1: "Inter", 2: "Bold", 4: "Inter Bold", 5: "Version 2.000", 6: "Inter-Bold" },
  weight: 700,
});
const INTER_REGULAR = buildFont({ names: { 1: "Inter", 2: "Regular", 6: "Inter-Regular" } });
const SERIF_OTF = buildFont({ names: { 1: "Serif", 2: "Italic", 6: "Serif-Italic" }, flavor: "otf", italic: true });
const ACME_TTC = buildCollection([
  { names: { 1: "Acme", 2: "Regular" } },
  { names: { 1: "Acme", 2: "Italic" }, italic: true },
]);
// Typographic names (16/17) differ from the legacy pair (1/2), as in most large families.
const DISPLAY_SEMIBOLD = buildFont({
  names: { 1: "Inter Display SemiBold", 2: "Regular", 16: "Inter Display", 17: "SemiBold" },
  weight: 600,
});
const GARBAGE = new TextEncoder().encode("definitely not a font, just some text");

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "font-sync-library-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function facesOf(bytes: Uint8Array): Face[] {
  return parseFont(bytes).faces;
}

/** A selected library folder owned by the signed-in user unless `capabilities` and `owner` say otherwise. */
function withLibrary(opts: Parameters<typeof setup>[0] & { capabilities?: typeof EDITOR_FOLDER; owner?: typeof OTHER } = {}) {
  const env = setup(opts);
  const root = env.drive.addFolder(LIBRARY_FOLDER_NAME, "root", {
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.owner ? { owner: opts.owner } : {}),
  });
  env.config.value.libraryFolderId = root.id;
  return { ...env, root };
}

function indexBytes(index: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(index));
}

function readIndex(env: ReturnType<typeof withLibrary>): SharedIndex {
  const node = [...env.drive.nodes.values()].find((n) => n.name === INDEX_FILE_NAME && !n.trashed);
  if (!node?.content) throw new Error("no index file");
  return JSON.parse(new TextDecoder().decode(node.content)) as SharedIndex;
}

describe("discovery and selection", () => {
  test("candidates lists only exactly named folders, newest first", async () => {
    const { library, drive } = setup();
    const mine = drive.addFolder(LIBRARY_FOLDER_NAME, "root");
    drive.addFolder("Font-Sync-Figma-Plugin copy", "root");
    const shared = drive.addFolder(LIBRARY_FOLDER_NAME, "elsewhere", { owner: OTHER, capabilities: EDITOR_FOLDER });

    const { folders, incomplete } = await library.candidates();
    expect(folders.map((f) => f.id)).toEqual([shared.id, mine.id]);
    expect(folders[0]).toEqual({
      id: shared.id,
      name: LIBRARY_FOLDER_NAME,
      owner: "other@example.com",
      webViewLink: shared.webViewLink ?? "",
      modifiedTime: shared.modifiedTime,
    });
    expect(incomplete).toBe(false);
  });

  test("candidates passes on that Google's search was partial", async () => {
    const { library, drive } = setup();
    drive.incompleteSearch = true;
    expect(await library.candidates()).toEqual({ folders: [], incomplete: true });
  });

  test("select validates the folder and stores its id", async () => {
    const { library, drive, config } = setup();
    const wrongName = drive.addFolder("fonts", "root");
    const notFolder = drive.addFile(LIBRARY_FOLDER_NAME, "root", INTER_BOLD);
    const good = drive.addFolder(LIBRARY_FOLDER_NAME, "root", { owner: OTHER, capabilities: EDITOR_FOLDER });

    await expect(library.select(wrongName.id)).rejects.toMatchObject({ code: "bad-request" });
    await expect(library.select(notFolder.id)).rejects.toMatchObject({ code: "bad-request" });
    await expect(library.select("missing")).rejects.toMatchObject({ code: "not-found" });
    expect(config.value.libraryFolderId).toBeNull();

    const info = await library.select(good.id);
    expect(info).toEqual({
      id: good.id,
      name: LIBRARY_FOLDER_NAME,
      webViewLink: good.webViewLink ?? "",
      owner: "other@example.com",
      role: "editor",
      canUpload: true,
    });
    expect(config.value.libraryFolderId).toBe(good.id);
  });

  test("create makes the folder in My Drive and selects it as its owner", async () => {
    const { library, drive, config } = setup();
    const info = await library.create();
    expect(drive.calls).toContain(`createFolder:${LIBRARY_FOLDER_NAME}`);
    expect(config.value.libraryFolderId).toBe(info.id);
    expect(info).toMatchObject({ name: LIBRARY_FOLDER_NAME, role: "owner", canUpload: true, owner: "me@example.com" });
  });

  test("roles come from ownership and capabilities; about() is asked once", async () => {
    const owner = withLibrary();
    expect(await owner.library.info()).toMatchObject({ role: "owner", canUpload: true });
    owner.drive.me = { emailAddress: "ME@Example.com", displayName: "Me" };
    await owner.library.info();
    expect(owner.drive.count("about")).toBe(1);

    const editor = withLibrary({ owner: OTHER, capabilities: EDITOR_FOLDER });
    expect(await editor.library.info()).toMatchObject({ role: "editor", canUpload: true, owner: "other@example.com" });

    const viewer = withLibrary({ owner: OTHER, capabilities: VIEWER_FOLDER });
    expect(await viewer.library.info()).toMatchObject({ role: "viewer", canUpload: false });
  });

  test("info is null without a library and clears an id whose folder is gone or trashed", async () => {
    expect(await setup().library.info()).toBeNull();

    const gone = setup({ libraryFolderId: "deleted-folder" });
    expect(await gone.library.info()).toBeNull();
    expect(gone.config.value.libraryFolderId).toBeNull();

    const trashed = withLibrary();
    trashed.drive.nodes.get(trashed.root.id)!.trashed = true;
    expect(await trashed.library.info()).toBeNull();
    expect(trashed.config.value.libraryFolderId).toBeNull();
  });

  test("folder methods throw no-library when none is selected", async () => {
    const { library } = setup();
    await expect(library.files({ refresh: false })).rejects.toMatchObject({ code: "no-library" });
    await expect(library.resolve([{ family: "Inter", style: "Bold" }])).rejects.toMatchObject({ code: "no-library" });
    await expect(library.install(["x"])).rejects.toMatchObject({ code: "no-library" });
    await expect(library.upload([{ name: "a.ttf", bytes: INTER_BOLD }])).rejects.toMatchObject({ code: "no-library" });
    await expect(library.members()).rejects.toMatchObject({ code: "no-library" });
  });

  test("Drive errors become HelperErrors", async () => {
    const { library, drive } = withLibrary();
    drive.getFile = async () => {
      throw new GoogleApiError(401, "authError", "Invalid Credentials");
    };
    await expect(library.files({ refresh: true })).rejects.toMatchObject({
      code: "not-signed-in",
      message: "Google sign-in expired; sign in again",
    });
    drive.getFile = async () => {
      throw new GoogleApiError(403, "insufficientFilePermissions", "No access.");
    };
    await expect(library.files({ refresh: true })).rejects.toMatchObject({ code: "forbidden" });
    drive.getFile = async () => {
      throw new GoogleApiError(500, "backendError", "Backend Error");
    };
    const error = await library.files({ refresh: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect(error).toMatchObject({ code: "google-error", message: "Backend Error" });
  });
});

describe("files", () => {
  test("walks nested folders, keeps font files only and records parse errors", async () => {
    const env = withLibrary();
    const { library, drive, root } = env;
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    drive.addFile("notes.txt", root.id, GARBAGE, { mimeType: "text/plain" });
    const broken = drive.addFile("Broken.TTF", root.id, GARBAGE);
    const sub = drive.addFolder("Serif", root.id);
    const b = drive.addFile("Serif-Italic.otf", sub.id, SERIF_OTF, { owner: OTHER, capabilities: caps() });
    const deeper = drive.addFolder("Collections", sub.id);
    const c = drive.addFile("Acme.ttc", deeper.id, ACME_TTC);

    const { files, syncedAt } = await library.files({ refresh: false });
    expect(syncedAt).toBe("2026-10-07T12:00:00.000Z");
    expect(files.map((f) => [f.path, f.name])).toEqual([
      ["", "Broken.TTF"],
      ["", "Inter-Bold.ttf"],
      ["Serif", "Serif-Italic.otf"],
      ["Serif/Collections", "Acme.ttc"],
    ]);

    const byId = new Map(files.map((f) => [f.id, f]));
    expect(byId.get(a.id)).toEqual({
      id: a.id,
      name: "Inter-Bold.ttf",
      path: "",
      size: INTER_BOLD.byteLength,
      md5: md5(INTER_BOLD),
      modifiedTime: a.modifiedTime,
      uploadedBy: "Me",
      faces: facesOf(INTER_BOLD),
      parseError: null,
      install: "not-installed",
      canRemove: true,
    });
    expect(byId.get(broken.id)).toMatchObject({ faces: [], parseError: expect.any(String) });
    // Not the uploader, but the folder owner can take it out of the folder.
    expect(byId.get(b.id)).toMatchObject({ uploadedBy: "Other Person", canRemove: true });
    expect(byId.get(c.id)?.faces.map((f) => f.style)).toEqual(["Regular", "Italic"]);
  });

  test("stops descending below five folder levels", async () => {
    const { library, drive, root } = withLibrary();
    let parent = root.id;
    for (let depth = 1; depth <= 7; depth++) {
      parent = drive.addFolder(`d${depth}`, parent).id;
      drive.addFile(`f${depth}.ttf`, parent, buildFont({ names: { 1: `F${depth}`, 2: "Regular" } }));
    }
    const { files } = await library.files({ refresh: false });
    expect(files.map((f) => f.name)).toEqual(["f1.ttf", "f2.ttf", "f3.ttf", "f4.ttf", "f5.ttf"]);
  });

  test("keeps the listing in memory and parses each version once", async () => {
    const { library, drive, root, facesCache } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    expect(drive.count(`download:${a.id}`)).toBe(1);
    expect(facesCache.value[`${a.id}:${md5(INTER_BOLD)}`]).toEqual({ faces: facesOf(INTER_BOLD), error: null });

    const before = drive.calls.length;
    await library.files({ refresh: false });
    expect(drive.calls.length).toBe(before);

    await library.files({ refresh: true });
    expect(drive.count("list:")).toBe(2);
    expect(drive.count(`download:${a.id}`)).toBe(1);

    drive.setContent(a.id, INTER_BOLD_V2);
    await library.files({ refresh: true });
    expect(drive.count(`download:${a.id}`)).toBe(2);
    expect(Object.keys(facesCache.value)).toEqual([`${a.id}:${md5(INTER_BOLD_V2)}`]);
  });

  test("uses the shared index when its md5 matches and never otherwise", async () => {
    const { library, drive, root } = withLibrary({ owner: OTHER, capabilities: VIEWER_FOLDER });
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD, { owner: OTHER });
    const b = drive.addFile("Inter-Regular.ttf", root.id, INTER_REGULAR, { owner: OTHER });
    const index = drive.addFile(
      INDEX_FILE_NAME,
      root.id,
      indexBytes({
        version: 1,
        files: {
          [a.id]: { md5: md5(INTER_BOLD), faces: facesOf(INTER_BOLD) },
          [b.id]: { md5: "stale-md5", faces: facesOf(INTER_BOLD) },
        },
      }),
      { mimeType: "application/json", owner: OTHER },
    );

    const { files } = await library.files({ refresh: false });
    expect(drive.count(`download:${index.id}`)).toBe(1);
    expect(drive.count(`download:${a.id}`)).toBe(0);
    expect(drive.count(`download:${b.id}`)).toBe(1);
    expect(files.find((f) => f.id === b.id)?.faces).toEqual(facesOf(INTER_REGULAR));
    // A viewer cannot write to the folder, so it never tries.
    expect(drive.count("upload:")).toBe(0);
    expect(drive.count("updateContent:")).toBe(0);
  });

  test("ignores a malformed index or one with another version", async () => {
    for (const content of [new TextEncoder().encode("{not json"), indexBytes({ version: 2, files: {} })]) {
      const { library, drive, root } = withLibrary({ owner: OTHER, capabilities: VIEWER_FOLDER });
      const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
      drive.addFile(INDEX_FILE_NAME, root.id, content, { mimeType: "application/json" });
      const { files } = await library.files({ refresh: false });
      expect(drive.count(`download:${a.id}`)).toBe(1);
      expect(files[0]?.faces).toEqual(facesOf(INTER_BOLD));
    }
  });

  test("an editor creates the index with what it parsed", async () => {
    const env = withLibrary({ owner: OTHER, capabilities: EDITOR_FOLDER });
    const { library, drive, root } = env;
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD, { owner: OTHER });
    drive.addFile("Broken.ttf", root.id, GARBAGE, { owner: OTHER });

    await library.files({ refresh: false });
    expect(drive.calls).toContain(`upload:${INDEX_FILE_NAME}`);
    expect(readIndex(env)).toEqual({
      version: 1,
      files: { [a.id]: { md5: md5(INTER_BOLD), faces: facesOf(INTER_BOLD) } },
    });

    // Nothing new to parse: no write.
    await library.files({ refresh: true });
    expect(drive.count("upload:")).toBe(1);
    expect(drive.count("updateContent:")).toBe(0);
  });

  test("an editor updates an existing index and prunes files that are gone", async () => {
    const env = withLibrary({ capabilities: EDITOR_FOLDER, owner: OTHER });
    const { library, drive, root } = env;
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    const index = drive.addFile(
      INDEX_FILE_NAME,
      root.id,
      indexBytes({ version: 1, files: { removedFile: { md5: "x", faces: [] } } }),
      { mimeType: "application/json" },
    );
    await library.files({ refresh: false });
    expect(drive.calls).toContain(`updateContent:${index.id}`);
    expect(Object.keys(readIndex(env).files)).toEqual([a.id]);
  });

  test("a failed index write does not fail the listing", async () => {
    const { library, drive, root } = withLibrary();
    drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    drive.failIndexWrites = true;
    const { files } = await library.files({ refresh: false });
    expect(files).toHaveLength(1);
  });

  test("a download that does not match Drive's md5 is reported and retried next time", async () => {
    const { library, drive, root, facesCache } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    drive.nodes.get(a.id)!.content = INTER_REGULAR;
    const { files } = await library.files({ refresh: false });
    expect(files[0]).toMatchObject({ faces: [], parseError: expect.stringContaining("checksum") });
    expect(facesCache.value).toEqual({});
  });
});

describe("install and uninstall", () => {
  test("installs a library file and records it", async () => {
    const { library, drive, root, installer, installed } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });

    const response = await library.install([a.id, "unknown"]);
    expect(response).toEqual({
      results: [
        { fileId: a.id, ok: true, error: null },
        { fileId: "unknown", ok: false, error: "Not in the library" },
      ],
      reloadRequired: true,
    });
    expect(installer.installs).toHaveLength(1);
    expect(installer.installs[0]).toMatchObject({
      md5: md5(INTER_BOLD),
      format: "ttf",
      faces: facesOf(INTER_BOLD),
      sourceName: "Inter-Bold.ttf",
    });
    expect(installer.installs[0]?.bytes).toEqual(INTER_BOLD);
    expect(installed.value.files[a.id]).toEqual({
      fileId: a.id,
      md5: md5(INTER_BOLD),
      name: "Inter-Bold.ttf",
      paths: [`/nonexistent/fonts/${md5(INTER_BOLD)}.ttf`],
      registryValues: [],
      faces: facesOf(INTER_BOLD),
      installedAt: "2026-10-07T12:00:00.000Z",
    });
    expect((await library.files({ refresh: false })).files[0]?.install).toBe("installed");
  });

  test("an unknown id alone needs no reload", async () => {
    const { library } = withLibrary();
    expect(await library.install(["nope"])).toEqual({
      results: [{ fileId: "nope", ok: false, error: "Not in the library" }],
      reloadRequired: false,
    });
  });

  test("a changed Drive file shows as outdated and is replaced new-first", async () => {
    const { library, drive, root, installer, installed } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    await library.install([a.id]);
    const oldPath = installed.value.files[a.id]?.paths[0];

    drive.setContent(a.id, INTER_BOLD_V2);
    const { files } = await library.files({ refresh: true });
    expect(files[0]?.install).toBe("outdated");

    installer.pendingDeletes = [oldPath ?? ""];
    installed.value.pendingDeletes = ["/already/pending.ttf"];
    const response = await library.install([a.id]);
    expect(response.results[0]).toEqual({ fileId: a.id, ok: true, error: null });
    expect(installer.log).toEqual([
      `install:${md5(INTER_BOLD)}`,
      `install:${md5(INTER_BOLD_V2)}`,
      `uninstall:${oldPath}`,
    ]);
    expect(installed.value.files[a.id]?.md5).toBe(md5(INTER_BOLD_V2));
    expect(installed.value.pendingDeletes).toEqual(["/already/pending.ttf", oldPath ?? ""]);
    expect((await library.files({ refresh: false })).files[0]?.install).toBe("installed");
  });

  test("an already installed version whose files exist is not installed again", async () => {
    const dir = await tempDir();
    const { library, drive, root, installer } = withLibrary({ installerDir: dir });
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    await library.install([a.id]);
    const downloads = drive.count(`download:${a.id}`);
    const again = await library.install([a.id]);
    expect(again.results[0]).toEqual({ fileId: a.id, ok: true, error: null });
    expect(installer.installs).toHaveLength(1);
    expect(drive.count(`download:${a.id}`)).toBe(downloads);
  });

  test("a file that changed since the listing fails the checksum and installs nothing", async () => {
    const { library, drive, root, installer, installed } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    drive.setContent(a.id, INTER_BOLD_V2);
    const response = await library.install([a.id]);
    expect(response.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("checksum") });
    expect(response.reloadRequired).toBe(false);
    expect(installer.installs).toHaveLength(0);
    expect(installed.value.files).toEqual({});
  });

  test("installer and Drive failures become per-file errors; an expired sign-in fails the request", async () => {
    const { library, drive, root, installer } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    const b = drive.addFile("Inter-Regular.ttf", root.id, INTER_REGULAR);
    await library.files({ refresh: false });

    installer.installError = new HelperError("install-failed", "Disk full");
    drive.downloadErrors.set(b.id, new GoogleApiError(403, "cannotDownloadFile", "Downloads are disabled."));
    expect((await library.install([a.id, b.id])).results).toEqual([
      { fileId: a.id, ok: false, error: "Disk full" },
      { fileId: b.id, ok: false, error: "Downloads are disabled." },
    ]);

    drive.downloadErrors.set(a.id, new GoogleApiError(401, "authError", "Invalid Credentials"));
    await expect(library.install([a.id])).rejects.toMatchObject({ code: "not-signed-in" });
  });

  test("installing a re-upload replaces the version whose file left the library, new first", async () => {
    const { library, drive, root, installer, installed } = withLibrary();
    const v1 = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    const serif = drive.addFile("Serif-Italic.otf", root.id, SERIF_OTF);
    const regular = drive.addFile("Inter-Regular.ttf", root.id, INTER_REGULAR);
    await library.files({ refresh: false });
    await library.install([v1.id, serif.id, regular.id]);
    const v1Path = installed.value.files[v1.id]?.paths[0] ?? "";

    // A teammate uploads v2 as a new Drive file and takes v1, and an unrelated font, out of the library.
    await library.remove(v1.id);
    await library.remove(serif.id);
    const v2 = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD_V2);
    await library.files({ refresh: true });

    installer.pendingDeletes = [v1Path];
    const response = await library.install([v2.id]);
    expect(response.results).toEqual([{ fileId: v2.id, ok: true, error: null }]);
    expect(installer.log.slice(-2)).toEqual([`install:${md5(INTER_BOLD_V2)}`, `uninstall:${v1Path}`]);
    expect(Object.keys(installed.value.files).sort()).toEqual([regular.id, serif.id, v2.id].sort());
    expect(installed.value.pendingDeletes).toEqual([v1Path]);
  });

  test("a re-upload of identical bytes takes over the installed file instead of deleting it", async () => {
    const { library, drive, root, installer, installed } = withLibrary();
    const first = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    await library.install([first.id]);
    const path = installed.value.files[first.id]?.paths[0] ?? "";

    await library.remove(first.id);
    const again = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: true });
    await library.install([again.id]);

    expect(installer.log.filter((line) => line.startsWith("uninstall:"))).toEqual([]);
    expect(Object.keys(installed.value.files)).toEqual([again.id]);
    expect(installed.value.files[again.id]?.paths).toEqual([path]);
    expect(installed.value.pendingDeletes).toEqual([]);
  });

  test("reinstalling a file that an uninstall left pending takes it off the pending list", async () => {
    const { library, drive, root, installer, installed } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    await library.install([a.id]);
    const path = installed.value.files[a.id]?.paths[0] ?? "";
    // Windows keeps a font Figma has loaded locked, so the delete waits for the next start.
    installer.pendingDeletes = [path];
    await library.uninstall([a.id]);
    expect(installed.value.pendingDeletes).toEqual([path]);

    installer.pendingDeletes = [];
    await library.install([a.id]);
    expect(installed.value.files[a.id]?.paths).toEqual([path]);
    expect(installed.value.pendingDeletes).toEqual([]);
  });

  test("two library files with identical bytes share one installed file; uninstalling one keeps it", async () => {
    const { library, drive, root, installer, installed } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    const copy = drive.addFile("Inter-Bold copy.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    await library.install([a.id, copy.id]);
    const path = installed.value.files[a.id]?.paths[0] ?? "";
    expect(installed.value.files[copy.id]?.paths).toEqual([path]);

    expect((await library.uninstall([a.id])).results).toEqual([{ fileId: a.id, ok: true, error: null }]);
    expect(installer.log.filter((line) => line.startsWith("uninstall:"))).toEqual([]);
    expect(Object.keys(installed.value.files)).toEqual([copy.id]);

    await library.uninstall([copy.id]);
    expect(installer.log.at(-1)).toBe(`uninstall:${path}`);
  });

  test("lists a font Font Sync installed whose file has left the library, so it can be uninstalled", async () => {
    const { library, drive, root, installed } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    await library.install([a.id]);
    await library.remove(a.id);

    const { files } = await library.files({ refresh: true });
    expect(files).toEqual([
      expect.objectContaining({ id: a.id, name: "Inter-Bold.ttf", install: "not-in-library", canRemove: false }),
    ]);
    expect(files[0]?.faces).toEqual(installed.value.files[a.id]?.faces ?? []);
  });

  test("uninstall removes only what Font Sync installed", async () => {
    const { library, drive, root, installer, installed } = withLibrary();
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    await library.install([a.id]);
    const path = installed.value.files[a.id]?.paths[0] ?? "";
    installer.pendingDeletes = [path];

    const response = await library.uninstall([a.id, "other"]);
    expect(response).toEqual({
      results: [
        { fileId: a.id, ok: true, error: null },
        { fileId: "other", ok: false, error: "Not installed by Font Sync" },
      ],
      reloadRequired: true,
    });
    expect(installer.log.at(-1)).toBe(`uninstall:${path}`);
    expect(installed.value).toEqual({ files: {}, pendingDeletes: [path] });
  });
});

describe("upload", () => {
  test("a viewer cannot upload", async () => {
    const { library, drive } = withLibrary({ owner: OTHER, capabilities: VIEWER_FOLDER });
    await expect(library.upload([{ name: "Inter-Bold.ttf", bytes: INTER_BOLD }])).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(drive.count("upload:")).toBe(0);
  });

  test("uploads valid fonts to the root, rejects invalid ones and reports duplicates", async () => {
    const env = withLibrary({ owner: OTHER, capabilities: EDITOR_FOLDER });
    const { library, drive, root, facesCache } = env;
    const existing = drive.addFile("Inter-Regular.ttf", root.id, INTER_REGULAR, { owner: OTHER });

    const results = await library.upload([
      { name: "C:\\Users\\me\\Inter-Bold.ttf", bytes: INTER_BOLD },
      { name: "copy of regular.ttf", bytes: INTER_REGULAR },
      { name: "notes.ttf", bytes: GARBAGE },
      { name: "../../Serif\u0007Italic", bytes: SERIF_OTF },
      { name: "Acme.ttc", bytes: ACME_TTC },
      { name: "Inter-Bold again.ttf", bytes: INTER_BOLD },
    ]);

    const uploaded = [...drive.nodes.values()].filter((n) => drive.calls.includes(`upload:${n.name}`));
    const byName = new Map(uploaded.map((n) => [n.name, n]));
    expect([...byName.keys()].sort()).toEqual(["Acme.ttc", "Inter-Bold.ttf", "SerifItalic.otf", INDEX_FILE_NAME].sort());
    expect(byName.get("Inter-Bold.ttf")).toMatchObject({ parents: [root.id], mimeType: "font/ttf" });
    expect(byName.get("SerifItalic.otf")?.mimeType).toBe("font/otf");
    expect(byName.get("Acme.ttc")?.mimeType).toBe("font/collection");

    const bold = byName.get("Inter-Bold.ttf")!;
    expect(results).toEqual([
      { name: "Inter-Bold.ttf", ok: true, fileId: bold.id, duplicateOf: null, error: null, faces: facesOf(INTER_BOLD) },
      {
        name: "copy of regular.ttf",
        ok: true,
        fileId: null,
        duplicateOf: existing.id,
        error: null,
        faces: facesOf(INTER_REGULAR),
      },
      { name: "notes.ttf", ok: false, fileId: null, duplicateOf: null, error: expect.any(String), faces: [] },
      expect.objectContaining({ name: "SerifItalic.otf", ok: true }),
      expect.objectContaining({ name: "Acme.ttc", ok: true }),
      expect.objectContaining({ ok: true, fileId: null, duplicateOf: bold.id }),
    ]);

    expect(facesCache.value[`${bold.id}:${md5(INTER_BOLD)}`]).toEqual({ faces: facesOf(INTER_BOLD), error: null });
    const listed = await library.files({ refresh: false });
    expect(listed.files.map((f) => f.name).sort()).toEqual(
      ["Acme.ttc", "Inter-Bold.ttf", "Inter-Regular.ttf", "SerifItalic.otf"].sort(),
    );
    expect(Object.keys(readIndex(env).files).sort()).toEqual(listed.files.map((f) => f.id).sort());
  });

  test("the duplicate check sees fonts a teammate uploaded since the last listing", async () => {
    const { library, drive, root } = withLibrary({ owner: OTHER, capabilities: EDITOR_FOLDER });
    await library.files({ refresh: false });
    const theirs = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD, { owner: OTHER });

    const [result] = await library.upload([{ name: "Inter-Bold.ttf", bytes: INTER_BOLD }]);
    expect(result).toMatchObject({ ok: true, fileId: null, duplicateOf: theirs.id });
    expect(drive.count("upload:Inter-Bold.ttf")).toBe(0);
  });

  test("rejects files over the size limit without parsing them", async () => {
    const { library, drive } = withLibrary();
    const [result] = await library.upload([{ name: "Huge.ttf", bytes: new Uint8Array(MAX_FONT_BYTES + 1) }]);
    expect(result).toMatchObject({ ok: false, error: "Larger than 50 MB" });
    expect(drive.count("upload:")).toBe(0);
  });
});

describe("publishLocal", () => {
  test("uploads each local non-system file once and reports fonts without one", async () => {
    const dir = await tempDir();
    const boldPath = join(dir, "Inter-Bold.ttf");
    const acmePath = join(dir, "Acme.ttc");
    await Bun.write(boldPath, INTER_BOLD);
    await Bun.write(acmePath, ACME_TTC);
    const [acmeRegular, acmeItalic] = facesOf(ACME_TTC);
    const local: LocalFace[] = [
      { path: "/System/Library/Fonts/Helvetica.ttc", system: true, face: { ...facesOf(INTER_REGULAR)[0]!, family: "Helvetica" } },
      { path: boldPath, system: false, face: facesOf(INTER_BOLD)[0]! },
      { path: acmePath, system: false, face: acmeRegular! },
      { path: acmePath, system: false, face: acmeItalic! },
    ];
    const { library, drive } = withLibrary({ localFonts: local });

    const results = await library.publishLocal([
      { family: "Acme", style: "Regular" },
      { family: "Helvetica", style: "Regular" },
      { family: "Inter", style: "Bold" },
      { family: "Acme", style: "Italic" },
      { family: "Nowhere", style: "Black" },
    ]);
    expect(results.map((r) => [r.name, r.ok, r.error])).toEqual([
      ["Acme.ttc", true, null],
      ["Helvetica Regular", false, "No local file for this font"],
      ["Inter-Bold.ttf", true, null],
      ["Nowhere Black", false, "No local file for this font"],
    ]);
    expect(drive.count("upload:Acme.ttc")).toBe(1);
    expect(drive.count("upload:Inter-Bold.ttf")).toBe(1);
  });

  test("a viewer cannot publish", async () => {
    const { library } = withLibrary({ owner: OTHER, capabilities: VIEWER_FOLDER });
    await expect(library.publishLocal([{ family: "Inter", style: "Bold" }])).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("remove", () => {
  test("trashes when the user may, otherwise unlinks from the folder, otherwise refuses", async () => {
    const { library, drive, root } = withLibrary({ owner: OTHER, capabilities: EDITOR_FOLDER });
    const mine = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD, { capabilities: caps({ canTrash: true }) });
    const sub = drive.addFolder("Sub", root.id, { owner: OTHER, capabilities: EDITOR_FOLDER });
    const theirs = drive.addFile("Inter-Regular.ttf", sub.id, INTER_REGULAR, { owner: OTHER, capabilities: caps() });
    const locked = drive.addFolder("Locked", root.id, { owner: OTHER, capabilities: VIEWER_FOLDER });
    const stuck = drive.addFile("Serif.otf", locked.id, SERIF_OTF, { owner: OTHER, capabilities: caps() });
    await library.files({ refresh: false });

    expect(await library.remove(mine.id)).toBe("trashed");
    expect(drive.calls).toContain(`trash:${mine.id}`);

    expect(await library.remove(theirs.id)).toBe("unlinked");
    expect(drive.calls).toContain(`removeParent:${theirs.id}:${sub.id}`);

    const error = await library.remove(stuck.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect(error).toMatchObject({
      code: "forbidden",
      message: "Only the person who uploaded this font (or the folder owner) can remove it",
    });

    await expect(library.remove("unknown")).rejects.toMatchObject({ code: "not-found" });
    const { files } = await library.files({ refresh: false });
    expect(files.map((f) => f.id)).toEqual([stuck.id]);
  });
});

describe("resolve", () => {
  test("matches by tier and reports local state", async () => {
    const dir = await tempDir();
    const local: LocalFace[] = [
      { path: join(dir, "Inter-Bold.ttf"), system: false, face: facesOf(INTER_BOLD)[0]! },
      { path: "/System/Library/Fonts/Serif.otf", system: true, face: facesOf(SERIF_OTF)[0]! },
      { path: join(dir, "Serif.otf"), system: false, face: facesOf(SERIF_OTF)[0]! },
      { path: "/System/Library/Fonts/Acme.ttc", system: true, face: facesOf(ACME_TTC)[0]! },
    ];
    const { library, drive, root } = withLibrary({ localFonts: local, installerDir: dir });
    const bold = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    const display = drive.addFile("InterDisplay-SemiBold.ttf", root.id, DISPLAY_SEMIBOLD);
    drive.addFile("Broken.ttf", root.id, GARBAGE);
    await library.files({ refresh: false });
    await library.install([bold.id]);

    const resolved = await library.resolve([
      { family: "Inter", style: "Bold" },
      { family: "inter", style: "bold" },
      { family: "Inter Display SemiBold", style: "Regular" },
      { family: "Serif", style: "Italic" },
      { family: "Acme", style: "Regular" },
    ]);

    expect(resolved[0]).toEqual({
      family: "Inter",
      style: "Bold",
      library: { fileId: bold.id, face: facesOf(INTER_BOLD)[0]!, tier: "exact" },
      local: { onDisk: true, installedBySync: true, uploadable: true },
    });
    expect(resolved[1]?.library).toMatchObject({ fileId: bold.id, tier: "normalized" });
    expect(resolved[2]?.library).toMatchObject({ fileId: display.id, tier: "alias" });
    expect(resolved[2]?.local).toEqual({ onDisk: false, installedBySync: false, uploadable: false });
    // A system copy listed first must not hide the user's own copy.
    expect(resolved[3]).toMatchObject({ library: null, local: { onDisk: true, installedBySync: false, uploadable: true } });
    expect(resolved[4]).toMatchObject({ library: null, local: { onDisk: true, uploadable: false } });
  });

  test("onDisk counts only a local face Figma lists under exactly that name", async () => {
    const acmeSemibold = buildFont({ names: { 1: "Acme", 2: "Semibold" }, weight: 600 });
    const local: LocalFace[] = [
      { path: "/fonts/Acme-Semibold.ttf", system: false, face: facesOf(acmeSemibold)[0]! },
      { path: "/fonts/InterDisplay-SemiBold.ttf", system: false, face: facesOf(DISPLAY_SEMIBOLD)[0]! },
    ];
    const { library } = withLibrary({ localFonts: local });
    const resolved = await library.resolve([
      // Same name except case: a normalized match.
      { family: "Acme", style: "SemiBold" },
      // The legacy name pair of a file Figma lists as {Inter Display, SemiBold}: an alias match.
      { family: "Inter Display SemiBold", style: "Regular" },
      { family: "Inter Display", style: "SemiBold" },
    ]);
    expect(resolved.map((font) => font.local.onDisk)).toEqual([false, false, true]);
  });

  test("installedBySync needs the library's current version with its files still on disk", async () => {
    const dir = await tempDir();
    const { library, drive, root } = withLibrary({ installerDir: dir });
    const a = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    await library.files({ refresh: false });
    await library.install([a.id]);
    const query = [{ family: "Inter", style: "Bold" }];
    expect((await library.resolve(query))[0]?.local.installedBySync).toBe(true);

    // Removed in Font Book: installed.json still has the record.
    await rm(join(dir, `${md5(INTER_BOLD)}.ttf`));
    expect((await library.resolve(query))[0]?.local.installedBySync).toBe(false);

    // Reinstalled, then the owner replaces the file's content in Drive.
    await library.install([a.id]);
    expect((await library.resolve(query))[0]?.local.installedBySync).toBe(true);
    drive.setContent(a.id, INTER_BOLD_V2);
    await library.files({ refresh: true });
    expect((await library.resolve(query))[0]?.local.installedBySync).toBe(false);
  });

  test("when several files provide a face, the most recently changed one answers", async () => {
    const { library, drive, root } = withLibrary();
    drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    const newer = drive.addFile("Inter-Bold.ttf", drive.addFolder("Inter 4", root.id).id, INTER_BOLD_V2);
    const [resolved] = await library.resolve([{ family: "Inter", style: "Bold" }]);
    expect(resolved?.library).toMatchObject({ fileId: newer.id, tier: "exact" });
  });

  test("a listing older than five minutes is read again before resolving", async () => {
    const { library, drive, root, clock } = withLibrary();
    drive.addFile("Inter-Regular.ttf", root.id, INTER_REGULAR);
    await library.files({ refresh: false });

    // A teammate uploads a font after this helper listed the library.
    const bold = drive.addFile("Inter-Bold.ttf", root.id, INTER_BOLD);
    const query = [{ family: "Inter", style: "Bold" }];
    clock.now = new Date(clock.now.getTime() + 4 * 60_000);
    expect((await library.resolve(query))[0]?.library).toBeNull();

    clock.now = new Date(clock.now.getTime() + 60_000);
    expect((await library.resolve(query))[0]?.library?.fileId).toBe(bold.id);
  });
});

describe("members", () => {
  test("lists the folder's permissions without deleted accounts", async () => {
    const { library, drive, root } = withLibrary();
    drive.permissions = [
      { id: "1", type: "user", role: "owner", emailAddress: "me@example.com", displayName: "Me", deleted: false },
      { id: "2", type: "user", role: "writer", emailAddress: "gone@example.com", displayName: null, deleted: true },
      { id: "3", type: "anyone", role: "reader", emailAddress: null, displayName: null, deleted: false },
    ];
    expect(await library.members()).toEqual([
      { email: "me@example.com", name: "Me", role: "owner", type: "user" },
      { email: null, name: null, role: "reader", type: "anyone" },
    ]);
    expect(drive.calls).toContain(`permissions:${root.id}`);
  });
});
