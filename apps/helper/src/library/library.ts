import { z } from "@hono/zod-openapi";
import { basename } from "node:path";
import {
  FaceSchema,
  type FolderSchema,
  type InstallResponseSchema,
  type LibraryFileSchema,
  type LibrarySchema,
  type MemberSchema,
  type ResolvedFontSchema,
  type UploadResultSchema,
} from "../api/schemas";
import type { Config, FacesCache, InstalledState, Store } from "../config/store";
import { HelperError } from "../errors";
import type { LocalFace } from "../fonts/local-scan";
import { FaceIndex } from "../fonts/match";
import { FontParseError, MAX_FONT_BYTES, parseFont } from "../fonts/sfnt";
import type { Face, FontFormat, FontKey, ParsedFont } from "../fonts/types";
import { type DriveClient, type DriveFile, FOLDER_MIME, GoogleApiError } from "../google/drive";
import type { InstalledFont, Installer } from "../install";

export const LIBRARY_FOLDER_NAME = "font-sync-figma-plugin";
export const INDEX_FILE_NAME = "font-sync-index.json";
export const FONT_EXTENSIONS = [".ttf", ".otf", ".ttc", ".otc"] as const;

export type LibraryInfo = z.infer<typeof LibrarySchema>;
export type Folder = z.infer<typeof FolderSchema>;
export type LibraryFile = z.infer<typeof LibraryFileSchema>;
export type ResolvedFont = z.infer<typeof ResolvedFontSchema>;
export type InstallResponse = z.infer<typeof InstallResponseSchema>;
export type UploadResult = z.infer<typeof UploadResultSchema>;
export type Member = z.infer<typeof MemberSchema>;

/** Shape of font-sync-index.json in the library folder. A cache shared by everyone: never trusted over md5. */
export type SharedIndex = {
  version: 1;
  files: Record<string, { md5: string; faces: LibraryFile["faces"] }>;
};

export type LibraryDeps = {
  drive: DriveClient;
  installer: Installer;
  config: Store<Config>;
  installed: Store<InstalledState>;
  facesCache: Store<FacesCache>;
  /** Fonts already on this machine (cached scan). */
  localFonts: () => Promise<LocalFace[]>;
  now?: () => Date;
};

const MAX_DEPTH = 5;
const MAX_FILES = 5000;
const DOWNLOAD_CONCURRENCY = 4;
// The helper runs for days; past this, resolve and install re-list so they see what teammates added.
const LISTING_MAX_AGE_MS = 5 * 60_000;
const INDEX_MIME = "application/json";
const UPLOAD_MIME: Record<FontFormat, string> = { ttf: "font/ttf", otf: "font/otf", ttc: "font/collection" };
const FORMAT_EXTENSION: Record<FontFormat, string> = { ttf: ".ttf", otf: ".otf", ttc: ".ttc" };
const CHECKSUM_MISMATCH = "The downloaded file does not match its Drive checksum; refresh the library and try again";
const NO_CHECKSUM = "Drive has not reported a checksum for this file yet; try again later";
const TOO_LARGE = `Larger than ${MAX_FONT_BYTES / 1024 / 1024} MB`;
/** Drive file ids; anything else in the shared index is ignored. */
const DRIVE_ID = /^[A-Za-z0-9_-]+$/;

const IndexEntrySchema = z.object({ md5: z.string(), faces: z.array(FaceSchema) });

type Entry = {
  file: DriveFile;
  /** Folder path inside the library, "" for the root. */
  path: string;
  /** The folder the file was listed in: its canRemoveChildren decides whether the file can be unlinked. */
  parent: DriveFile;
  faces: Face[];
  parseError: string | null;
};

type Listing = {
  folderId: string;
  root: DriveFile;
  entries: Map<string, Entry>;
  indexFileId: string | null;
  syncedAt: string;
};

type FileResult = InstallResponse["results"][number];

/**
 * The selected Drive folder as a font library. All methods that need a folder throw
 * HelperError("no-library") when none is selected; Drive 403/404 become "forbidden"/"not-found",
 * other Drive failures "google-error".
 */
export class Library {
  private listing: Listing | null = null;
  private loading: { folderId: string; promise: Promise<Listing> } | null = null;
  private myEmail: Promise<string> | null = null;
  // Installs, uninstalls, uploads and removals run one at a time: each reads state the previous one changes.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LibraryDeps) {}

  /**
   * Folders named LIBRARY_FOLDER_NAME the user can see, newest first. `incomplete` means Google did not
   * search every shared drive, so an empty list does not prove there is no library.
   */
  async candidates(): Promise<{ folders: Folder[]; incomplete: boolean }> {
    return this.guard(async () => {
      const { files, incomplete } = await this.deps.drive.findFoldersByName(LIBRARY_FOLDER_NAME);
      const folders = files
        .filter((folder) => folder.name === LIBRARY_FOLDER_NAME)
        .map((folder) => ({
          id: folder.id,
          name: folder.name,
          owner: ownerOf(folder),
          webViewLink: folder.webViewLink ?? folderLink(folder.id),
          modifiedTime: folder.modifiedTime,
        }));
      return { folders, incomplete };
    });
  }

  /** Validates name, mimeType and access, then stores the id in config. */
  async select(folderId: string): Promise<LibraryInfo> {
    return this.guard(async () => {
      const folder = await this.deps.drive.getFile(folderId);
      if (folder.mimeType !== FOLDER_MIME) throw new HelperError("bad-request", "That Drive item is not a folder");
      if (folder.name !== LIBRARY_FOLDER_NAME) {
        throw new HelperError("bad-request", `The library folder must be named ${LIBRARY_FOLDER_NAME}`);
      }
      if (folder.trashed) throw new HelperError("not-found", "That folder is in the Drive trash");
      if (!folder.capabilities.canListChildren) {
        throw new HelperError("forbidden", "You do not have access to the files in this folder");
      }
      await this.useFolder(folder.id);
      return this.toInfo(folder);
    });
  }

  /** Creates LIBRARY_FOLDER_NAME in the user's My Drive and selects it. */
  async create(): Promise<LibraryInfo> {
    return this.guard(async () => {
      const folder = await this.deps.drive.createFolder(LIBRARY_FOLDER_NAME);
      await this.useFolder(folder.id);
      return this.toInfo(folder);
    });
  }

  /** The selected library with this user's role, or null. Clears a stale id if the folder is gone. */
  async info(): Promise<LibraryInfo | null> {
    return this.guard(async () => {
      const { libraryFolderId } = await this.deps.config.read();
      if (!libraryFolderId) return null;
      let folder: DriveFile;
      try {
        folder = await this.deps.drive.getFile(libraryFolderId);
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 404)) throw error;
        await this.forgetFolder(libraryFolderId);
        return null;
      }
      if (folder.trashed) {
        await this.forgetFolder(libraryFolderId);
        return null;
      }
      return this.toInfo(folder);
    });
  }

  /**
   * Font files in the library (recursive), with faces and this machine's install state.
   * Results are kept in memory; `refresh` re-lists Drive. Faces come from facesCache, then the
   * shared index (same md5), then download + parse. When this user can add children, newly parsed
   * entries are written back to INDEX_FILE_NAME (created if missing).
   */
  async files(opts: { refresh: boolean }): Promise<{ files: LibraryFile[]; syncedAt: string }> {
    return this.guard(async () => {
      const listing = await this.load(opts.refresh);
      const installed = await this.deps.installed.read();
      // Fonts Font Sync installed whose file has left the library stay listed, so they can be uninstalled.
      const orphans = Object.values(installed.files)
        .filter((record) => !listing.entries.has(record.fileId))
        .map(
          (record): LibraryFile => ({
            id: record.fileId,
            name: record.name,
            path: "",
            size: 0,
            md5: record.md5,
            modifiedTime: record.installedAt,
            uploadedBy: null,
            faces: record.faces,
            parseError: null,
            install: "not-in-library",
            canRemove: false,
          }),
        );
      return {
        files: [...ordered(listing).map((entry) => toLibraryFile(entry, installed)), ...orphans],
        syncedAt: listing.syncedAt,
      };
    });
  }

  /** Library match (FaceIndex tiers) and local state for each font, in request order. */
  async resolve(fonts: FontKey[]): Promise<ResolvedFont[]> {
    return this.guard(async () => {
      const listing = await this.load(false);
      const [installed, local] = await Promise.all([this.deps.installed.read(), this.deps.localFonts()]);
      // A record counts only while it is the library's current version and its files are still there:
      // Font Book or Explorer can remove a font without telling Font Sync.
      const current = new Set<string>();
      await Promise.all(
        Object.entries(installed.files).map(async ([fileId, record]) => {
          const entry = listing.entries.get(fileId);
          if (entry && record.md5 === entry.file.md5Checksum && (await allExist(record.paths))) current.add(fileId);
        }),
      );
      const library = new FaceIndex(
        byPreference(listing)
          .filter((entry) => entry.parseError === null)
          .flatMap((entry) => entry.faces.map((face) => ({ face, ref: entry.file.id }))),
      );
      const onDisk = new FaceIndex(local.map((font) => ({ face: font.face, ref: font })));
      // A separate index, because a system face matching first would hide an uploadable one.
      const uploadable = new FaceIndex(local.filter((font) => !font.system).map((font) => ({ face: font.face, ref: font })));
      return fonts.map((font) => {
        const match = library.match(font);
        return {
          family: font.family,
          style: font.style,
          library: match ? { fileId: match.ref, face: match.face, tier: match.tier } : null,
          local: {
            // Figma lists a local font under its exact {family, style}; a looser match is a key it never offers.
            onDisk: onDisk.match(font)?.tier === "exact",
            installedBySync: match !== null && current.has(match.ref),
            uploadable: uploadable.match(font) !== null,
          },
        };
      });
    });
  }

  /** Downloads, checks md5, parses, installs. An installed older version is replaced (new file first). */
  async install(fileIds: string[]): Promise<InstallResponse> {
    return this.guard(() =>
      this.serial(async () => {
        const listing = await this.load(false);
        const results: FileResult[] = [];
        for (const fileId of fileIds) results.push(await this.installOne(listing, fileId));
        return { results, reloadRequired: results.some((result) => result.ok) };
      }),
    );
  }

  /** Only files Font Sync installed can be uninstalled. */
  async uninstall(fileIds: string[]): Promise<InstallResponse> {
    return this.serial(async () => {
      const results: FileResult[] = [];
      for (const fileId of fileIds) {
        const state = await this.deps.installed.read();
        const record = state.files[fileId];
        if (!record) {
          results.push({ fileId, ok: false, error: "Not installed by Font Sync" });
          continue;
        }
        try {
          const others = Object.values(state.files).filter((other) => other.fileId !== fileId);
          const { pendingDeletes } = await this.uninstallOwned(record, others);
          await this.deps.installed.update((state) => {
            delete state.files[fileId];
            addPending(state, pendingDeletes);
          });
          results.push({ fileId, ok: true, error: null });
        } catch (error) {
          results.push({ fileId, ok: false, error: messageOf(error) });
        }
      }
      return { results, reloadRequired: results.some((result) => result.ok) };
    });
  }

  /**
   * Requires canAddChildren on the folder (HelperError "forbidden"). Each file is validated with
   * parseFont; an md5 already in the library is reported as duplicateOf instead of uploaded.
   */
  async upload(files: { name: string; bytes: Uint8Array }[]): Promise<UploadResult[]> {
    return this.guard(() =>
      this.serial(async () => {
        const root = await this.writableRoot();
        return this.uploadAll(
          root,
          files.map((file) => ({ name: file.name, read: async () => file.bytes })),
        );
      }),
    );
  }

  /** Uploads the local, non-system files that provide these fonts. */
  async publishLocal(fonts: FontKey[]): Promise<UploadResult[]> {
    return this.guard(() =>
      this.serial(async () => {
        const root = await this.writableRoot();
        const local = new FaceIndex(
          (await this.deps.localFonts()).filter((font) => !font.system).map((font) => ({ face: font.face, ref: font })),
        );
        // One slot per distinct file or missing font, in request order; uploads fill the file slots.
        const slots: ({ path: string } | { missing: FontKey })[] = [];
        const paths = new Set<string>();
        for (const font of fonts) {
          const match = local.match(font);
          if (!match) slots.push({ missing: font });
          else if (!paths.has(match.ref.path)) {
            paths.add(match.ref.path);
            slots.push({ path: match.ref.path });
          }
        }
        const uploads = await this.uploadAll(
          root,
          [...paths].map((path) => ({ name: basename(path), read: () => Bun.file(path).bytes() })),
        );
        let next = 0;
        return slots.map((slot) =>
          "missing" in slot
            ? failedUpload(`${slot.missing.family} ${slot.missing.style}`, "No local file for this font")
            : (uploads[next++] ?? failedUpload(basename(slot.path), "Upload did not run")),
        );
      }),
    );
  }

  /** Trashes the file when the user may (canTrash), otherwise removes it from its library folder. */
  async remove(fileId: string): Promise<"trashed" | "unlinked"> {
    return this.guard(() =>
      this.serial(async () => {
        const listing = await this.load(false);
        const entry = listing.entries.get(fileId);
        if (!entry) throw new HelperError("not-found", "Not in the library");
        let removed: "trashed" | "unlinked";
        if (entry.file.capabilities.canTrash) {
          await this.deps.drive.trash(fileId);
          removed = "trashed";
        } else if (entry.parent.capabilities.canRemoveChildren) {
          await this.deps.drive.removeParent(fileId, entry.parent.id);
          removed = "unlinked";
        } else {
          throw new HelperError("forbidden", "Only the person who uploaded this font (or the folder owner) can remove it");
        }
        listing.entries.delete(fileId);
        return removed;
      }),
    );
  }

  async members(): Promise<Member[]> {
    return this.guard(async () => {
      const permissions = await this.deps.drive.listPermissions(await this.folderId());
      return permissions
        .filter((permission) => !permission.deleted)
        .map((permission) => ({
          email: permission.emailAddress,
          name: permission.displayName,
          role: permission.role,
          type: permission.type,
        }));
    });
  }

  private async folderId(): Promise<string> {
    const { libraryFolderId } = await this.deps.config.read();
    if (!libraryFolderId) throw new HelperError("no-library", "Choose a library folder first");
    return libraryFolderId;
  }

  private async useFolder(folderId: string): Promise<void> {
    await this.deps.config.update((config) => {
      config.libraryFolderId = folderId;
    });
    if (this.listing?.folderId !== folderId) this.listing = null;
  }

  private async forgetFolder(folderId: string): Promise<void> {
    await this.deps.config.update((config) => {
      if (config.libraryFolderId === folderId) config.libraryFolderId = null;
    });
    if (this.listing?.folderId === folderId) this.listing = null;
  }

  private async writableRoot(): Promise<DriveFile> {
    const root = await this.deps.drive.getFile(await this.folderId());
    if (!root.capabilities.canAddChildren) {
      throw new HelperError("forbidden", "You can use this library but not add fonts to it; ask its owner for edit access");
    }
    return root;
  }

  private async toInfo(folder: DriveFile): Promise<LibraryInfo> {
    return {
      id: folder.id,
      name: folder.name,
      webViewLink: folder.webViewLink ?? folderLink(folder.id),
      owner: ownerOf(folder),
      role: await this.roleIn(folder),
      canUpload: folder.capabilities.canAddChildren,
    };
  }

  private async roleIn(folder: DriveFile): Promise<LibraryInfo["role"]> {
    // Shared drive folders have no owners, so there is nobody to compare against.
    if (folder.owners.length > 0) {
      const me = await this.email();
      if (folder.owners.some((owner) => owner.emailAddress?.toLowerCase() === me)) return "owner";
    }
    return folder.capabilities.canAddChildren ? "editor" : "viewer";
  }

  private email(): Promise<string> {
    if (!this.myEmail) {
      const pending = this.deps.drive.about().then((about) => about.email.toLowerCase());
      this.myEmail = pending;
      pending.catch(() => {
        if (this.myEmail === pending) this.myEmail = null;
      });
    }
    return this.myEmail;
  }

  /** The in-memory listing for the selected folder, re-listed when asked, missing or older than LISTING_MAX_AGE_MS. */
  private async load(refresh: boolean): Promise<Listing> {
    const folderId = await this.folderId();
    const cached = this.listing;
    const fresh =
      cached?.folderId === folderId && this.now().getTime() - Date.parse(cached.syncedAt) < LISTING_MAX_AGE_MS;
    if (!refresh && fresh) return cached;
    // Concurrent refreshes share one walk of the folder.
    if (this.loading?.folderId !== folderId) {
      const promise = this.list(folderId).finally(() => {
        if (this.loading?.promise === promise) this.loading = null;
      });
      this.loading = { folderId, promise };
    }
    const listing = await this.loading.promise;
    this.listing = listing;
    return listing;
  }

  private async list(folderId: string): Promise<Listing> {
    const { drive } = this.deps;
    const root = await drive.getFile(folderId);
    const found: Entry[] = [];
    let indexFile: DriveFile | null = null;

    const queue = [{ folder: root, path: "", depth: 0 }];
    const seen = new Set([root.id]);
    for (let i = 0; i < queue.length && found.length < MAX_FILES; i++) {
      const { folder, path, depth } = queue[i]!;
      for (const child of await drive.listChildren(folder)) {
        if (child.mimeType === FOLDER_MIME) {
          if (depth < MAX_DEPTH && !seen.has(child.id)) {
            seen.add(child.id);
            queue.push({ folder: child, path: path ? `${path}/${child.name}` : child.name, depth: depth + 1 });
          }
        } else if (isFontName(child.name)) {
          if (found.length < MAX_FILES) found.push({ file: child, path, parent: folder, faces: [], parseError: null });
        } else if (depth === 0 && child.name === INDEX_FILE_NAME) {
          // Two editors can create the index at once; the newest copy is the one that keeps being written.
          if (!indexFile || child.modifiedTime > indexFile.modifiedTime) indexFile = child;
        }
      }
    }

    const shared = indexFile ? await this.readIndex(indexFile.id) : null;
    const cache = await this.deps.facesCache.read();
    const cacheUpdates: FacesCache = {};
    const toParse: Entry[] = [];
    for (const entry of found) {
      const md5 = entry.file.md5Checksum;
      if (!md5) {
        entry.parseError = NO_CHECKSUM;
        continue;
      }
      const key = cacheKey(entry.file.id, md5);
      const cached = cache[key];
      const indexed = shared?.files[entry.file.id];
      if (cached) {
        entry.faces = cached.faces;
        entry.parseError = cached.error;
      } else if (indexed?.md5 === md5) {
        entry.faces = indexed.faces;
        cacheUpdates[key] = { faces: indexed.faces, error: null };
      } else {
        toParse.push(entry);
      }
    }

    let parsedNew = false;
    await forEachLimit(toParse, DOWNLOAD_CONCURRENCY, async (entry) => {
      const outcome = await this.parseRemote(entry.file);
      entry.faces = outcome.faces;
      entry.parseError = outcome.error;
      if (outcome.cacheable) {
        cacheUpdates[cacheKey(entry.file.id, entry.file.md5Checksum ?? "")] = { faces: outcome.faces, error: outcome.error };
      }
      if (outcome.error === null) parsedNew = true;
    });
    if (Object.keys(cacheUpdates).length > 0) await this.cacheFaces(cacheUpdates, found);

    const listing: Listing = {
      folderId,
      root,
      entries: new Map(found.map((entry) => [entry.file.id, entry])),
      indexFileId: indexFile?.id ?? null,
      syncedAt: this.now().toISOString(),
    };
    if (parsedNew && root.capabilities.canAddChildren) await this.writeIndex(listing);
    return listing;
  }

  private async parseRemote(file: DriveFile): Promise<{ faces: Face[]; error: string | null; cacheable: boolean }> {
    if ((file.size ?? 0) > MAX_FONT_BYTES) return { faces: [], error: TOO_LARGE, cacheable: true };
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.drive.download(file.id);
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      // Not cached: a download can fail for reasons that go away (quota, network, owner settings).
      return { faces: [], error: messageOf(error), cacheable: false };
    }
    if (md5Hex(bytes) !== file.md5Checksum) return { faces: [], error: CHECKSUM_MISMATCH, cacheable: false };
    try {
      return { faces: parseFont(bytes).faces, error: null, cacheable: true };
    } catch (error) {
      if (error instanceof FontParseError) return { faces: [], error: error.message, cacheable: true };
      // One unreadable file must not take the whole library down with it.
      return { faces: [], error: "Could not read this font file", cacheable: false };
    }
  }

  private async readIndex(fileId: string): Promise<SharedIndex | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.drive.download(fileId);
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      return null;
    }
    return parseIndex(bytes);
  }

  private async cacheFaces(updates: FacesCache, entries: Entry[]): Promise<void> {
    const current = new Map(entries.map((entry) => [entry.file.id, entry.file.md5Checksum]));
    await this.deps.facesCache.update((cache) => {
      // Drop faces of earlier versions of these files; they can never be looked up again.
      for (const key of Object.keys(cache)) {
        const fileId = key.slice(0, key.lastIndexOf(":"));
        const md5 = current.get(fileId);
        if (md5 !== undefined && key !== cacheKey(fileId, md5 ?? "")) delete cache[key];
      }
      Object.assign(cache, updates);
    });
  }

  private async writeIndex(listing: Listing): Promise<void> {
    const index: SharedIndex = { version: 1, files: {} };
    for (const entry of listing.entries.values()) {
      if (entry.file.md5Checksum && entry.parseError === null) {
        index.files[entry.file.id] = { md5: entry.file.md5Checksum, faces: entry.faces };
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(index));
    try {
      if (listing.indexFileId) {
        await this.deps.drive.updateContent(listing.indexFileId, bytes, INDEX_MIME);
      } else {
        const created = await this.deps.drive.upload({
          name: INDEX_FILE_NAME,
          parentId: listing.folderId,
          bytes,
          mimeType: INDEX_MIME,
        });
        listing.indexFileId = created.id;
      }
    } catch {
      // The index is a cache: a lost write only costs the next person a download and parse.
    }
  }

  /** Uninstalls only the paths and registry values no record in `others` also uses. */
  private async uninstallOwned(font: InstalledFont, others: InstalledFont[]): Promise<{ pendingDeletes: string[] }> {
    const owned = ownedBy(font, others);
    if (owned.paths.length === 0 && owned.registryValues.length === 0) return { pendingDeletes: [] };
    return this.deps.installer.uninstall(owned);
  }

  private async installOne(listing: Listing, fileId: string): Promise<FileResult> {
    const entry = listing.entries.get(fileId);
    if (!entry) return { fileId, ok: false, error: "Not in the library" };
    const md5 = entry.file.md5Checksum;
    if (!md5) return { fileId, ok: false, error: NO_CHECKSUM };
    try {
      const before = await this.deps.installed.read();
      const previous = before.files[fileId];
      if (previous?.md5 === md5 && (await allExist(previous.paths))) return { fileId, ok: true, error: null };

      const bytes = await this.deps.drive.download(fileId);
      if (md5Hex(bytes) !== md5) return { fileId, ok: false, error: CHECKSUM_MISMATCH };
      const parsed: ParsedFont = parseFont(bytes);
      const font = await this.deps.installer.install({
        bytes,
        md5,
        format: parsed.format,
        faces: parsed.faces,
        sourceName: entry.file.name,
      });

      // A new upload of a font is a new Drive file, so an installed file that has left the library and
      // provides one of the same faces is an older version of this one.
      const superseded = Object.values(before.files).filter(
        (record) =>
          record.fileId !== fileId &&
          !listing.entries.has(record.fileId) &&
          record.faces.some((face) => parsed.faces.some((p) => p.family === face.family && p.style === face.style)),
      );
      // The old version goes only after the new one is registered, so the font never disappears in between.
      const pending: string[] = [];
      const leaving = previous && previous.md5 !== md5 ? [previous, ...superseded] : superseded;
      // The same bytes re-uploaded install to the same path and registry value, which now belong to the new
      // record; another library file with identical bytes shares them too.
      const staying = [
        ...Object.values(before.files).filter((record) => record.fileId !== fileId && !superseded.includes(record)),
        font,
      ];
      for (const old of leaving) {
        try {
          pending.push(...(await this.uninstallOwned(old, staying)).pendingDeletes);
        } catch {
          // The new version is in place; queue the old files so the startup retry removes them.
          pending.push(...ownedBy(old, staying).paths);
        }
      }
      await this.deps.installed.update((state) => {
        for (const old of superseded) delete state.files[old.fileId];
        state.files[fileId] = {
          fileId,
          md5,
          name: entry.file.name,
          paths: font.paths,
          registryValues: font.registryValues,
          faces: parsed.faces,
          installedAt: this.now().toISOString(),
        };
        addPending(state, pending);
        // An earlier uninstall may have left this very file pending (Windows lock); the install reused it.
        state.pendingDeletes = state.pendingDeletes.filter((path) => !font.paths.includes(path));
      });
      return { fileId, ok: true, error: null };
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      return { fileId, ok: false, error: messageOf(error) };
    }
  }

  private async uploadAll(
    root: DriveFile,
    files: { name: string; read: () => Promise<Uint8Array> }[],
  ): Promise<UploadResult[]> {
    // The md5 duplicate check has to see what teammates uploaded since the last listing.
    const listing = await this.load(true);
    const sameFolder = listing.folderId === root.id;
    const cacheUpdates: FacesCache = {};
    const results: UploadResult[] = [];
    for (const input of files) {
      const name = cleanName(input.name);
      try {
        const bytes = await input.read();
        if (bytes.byteLength > MAX_FONT_BYTES) {
          results.push(failedUpload(name, TOO_LARGE));
          continue;
        }
        let parsed: ParsedFont;
        try {
          parsed = parseFont(bytes);
        } catch (error) {
          results.push(failedUpload(name, error instanceof FontParseError ? error.message : "Not a font file"));
          continue;
        }
        const md5 = md5Hex(bytes);
        const duplicate = [...listing.entries.values()].find((entry) => entry.file.md5Checksum === md5);
        if (duplicate) {
          results.push({ name, ok: true, fileId: null, duplicateOf: duplicate.file.id, error: null, faces: parsed.faces });
          continue;
        }
        const uploaded = await this.deps.drive.upload({
          name: withFontExtension(name, parsed.format),
          parentId: root.id,
          bytes,
          mimeType: UPLOAD_MIME[parsed.format],
        });
        const file: DriveFile = { ...uploaded, md5Checksum: uploaded.md5Checksum ?? md5 };
        if (sameFolder) listing.entries.set(file.id, { file, path: "", parent: root, faces: parsed.faces, parseError: null });
        cacheUpdates[cacheKey(file.id, md5)] = { faces: parsed.faces, error: null };
        results.push({ name: file.name, ok: true, fileId: file.id, duplicateOf: null, error: null, faces: parsed.faces });
      } catch (error) {
        if (isAuthFailure(error)) throw error;
        results.push(failedUpload(name, messageOf(error)));
      }
    }
    if (Object.keys(cacheUpdates).length > 0) {
      await this.deps.facesCache.update((cache) => {
        Object.assign(cache, cacheUpdates);
      });
      if (sameFolder) await this.writeIndex(listing);
    }
    return results;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toHelperError(error);
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

function toHelperError(error: unknown): unknown {
  if (!(error instanceof GoogleApiError)) return error;
  switch (error.status) {
    case 401:
      return new HelperError("not-signed-in", "Google sign-in expired; sign in again");
    case 403:
      return new HelperError("forbidden", error.message);
    case 404:
      return new HelperError("not-found", error.message);
    default:
      return new HelperError("google-error", error.message);
  }
}

/** Failures that end the whole request instead of becoming one file's error. */
function isAuthFailure(error: unknown): boolean {
  if (error instanceof GoogleApiError) return error.status === 401;
  return error instanceof HelperError && (error.code === "not-signed-in" || error.code === "not-configured");
}

function messageOf(error: unknown): string {
  const mapped = toHelperError(error);
  return mapped instanceof Error ? mapped.message : String(mapped);
}

function ordered(listing: Listing): Entry[] {
  return [...listing.entries.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.file.name.localeCompare(b.file.name) || a.file.id.localeCompare(b.file.id),
  );
}

function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which file answers for a face when several provide it: the most recently changed, then a stable
 * tiebreak. Not localeCompare, so every helper picks the same file. modifiedTime is RFC 3339 UTC.
 */
function byPreference(listing: Listing): Entry[] {
  return [...listing.entries.values()].sort(
    (a, b) =>
      byCode(b.file.modifiedTime, a.file.modifiedTime) ||
      byCode(a.path, b.path) ||
      byCode(a.file.name, b.file.name) ||
      byCode(a.file.id, b.file.id),
  );
}

function toLibraryFile(entry: Entry, installed: InstalledState): LibraryFile {
  const md5 = entry.file.md5Checksum ?? "";
  const record = installed.files[entry.file.id];
  // In a shared drive files have no owners; the last modifier is the closest to "who uploaded it".
  const uploader = entry.file.owners[0] ?? entry.file.lastModifyingUser;
  return {
    id: entry.file.id,
    name: entry.file.name,
    path: entry.path,
    size: entry.file.size ?? 0,
    md5,
    modifiedTime: entry.file.modifiedTime,
    uploadedBy: uploader ? (uploader.displayName ?? uploader.emailAddress) : null,
    faces: entry.faces,
    parseError: entry.parseError,
    install: !record ? "not-installed" : record.md5 === md5 ? "installed" : "outdated",
    canRemove: entry.file.capabilities.canTrash || entry.parent.capabilities.canRemoveChildren,
  };
}

function parseIndex(bytes: Uint8Array): SharedIndex | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(json) || json.version !== 1 || !isRecord(json.files)) return null;
  // Keys come from a file anyone in the folder can edit; a null prototype keeps "__proto__" an ordinary key.
  const index: SharedIndex = { version: 1, files: Object.create(null) as SharedIndex["files"] };
  for (const [fileId, raw] of Object.entries(json.files)) {
    const entry = IndexEntrySchema.safeParse(raw);
    if (DRIVE_ID.test(fileId) && entry.success) index.files[fileId] = entry.data;
  }
  return index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFontName(name: string): boolean {
  const lower = name.toLowerCase();
  return FONT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** The user's own name for the file, minus any directory part and control characters. */
function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "font";
}

/** Without a font extension the file would be invisible to every listing, including this one. */
function withFontExtension(name: string, format: FontFormat): string {
  return isFontName(name) ? name : `${name}${FORMAT_EXTENSION[format]}`;
}

function failedUpload(name: string, error: string): UploadResult {
  return { name, ok: false, fileId: null, duplicateOf: null, error, faces: [] };
}

function ownerOf(file: DriveFile): string | null {
  const owner = file.owners[0];
  return owner ? (owner.emailAddress ?? owner.displayName) : null;
}

function folderLink(id: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

function cacheKey(fileId: string, md5: string): string {
  return `${fileId}:${md5}`;
}

function md5Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("md5").update(bytes).digest("hex");
}

/** Identical bytes install to one path and registry value, so two records can share them. */
function ownedBy(font: InstalledFont, others: InstalledFont[]): InstalledFont {
  const paths = new Set(others.flatMap((other) => other.paths));
  const registryValues = new Set(others.flatMap((other) => other.registryValues));
  return {
    paths: font.paths.filter((path) => !paths.has(path)),
    registryValues: font.registryValues.filter((value) => !registryValues.has(value)),
  };
}

function addPending(state: InstalledState, paths: string[]): void {
  for (const path of paths) if (!state.pendingDeletes.includes(path)) state.pendingDeletes.push(path);
}

async function allExist(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  const exists = await Promise.all(paths.map((path) => Bun.file(path).exists()));
  return exists.every(Boolean);
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
