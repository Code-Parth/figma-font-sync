import type { Config, FacesCache, InstalledState, Store } from "../../src/config/store";
import type { LocalFace } from "../../src/fonts/local-scan";
import {
  type DriveCapabilities,
  DriveClient,
  type DriveFile,
  type DrivePermission,
  type DriveUser,
  FOLDER_MIME,
  GoogleApiError,
} from "../../src/google/drive";
import type { InstalledFont, InstallInput, Installer } from "../../src/install";
import { Library } from "../../src/library/library";

export const ME: DriveUser = { emailAddress: "me@example.com", displayName: "Me" };
export const OTHER: DriveUser = { emailAddress: "other@example.com", displayName: "Other Person" };

export function caps(overrides: Partial<DriveCapabilities> = {}): DriveCapabilities {
  return {
    canAddChildren: false,
    canListChildren: false,
    canEdit: false,
    canTrash: false,
    canRemoveChildren: false,
    canDownload: true,
    ...overrides,
  };
}

export const OWNER_FOLDER = caps({ canAddChildren: true, canListChildren: true, canEdit: true, canTrash: true, canRemoveChildren: true });
export const EDITOR_FOLDER = caps({ canAddChildren: true, canListChildren: true, canEdit: true, canRemoveChildren: true });
export const VIEWER_FOLDER = caps({ canListChildren: true });

type Node = DriveFile & { content: Uint8Array | null };

export function md5(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("md5").update(bytes).digest("hex");
}

/** An in-memory Drive with the semantics the library relies on. Records every call by name. */
export class FakeDrive extends DriveClient {
  readonly nodes = new Map<string, Node>();
  readonly calls: string[] = [];
  me: DriveUser = ME;
  permissions: DrivePermission[] = [];
  /** Ids whose download fails with this error. */
  readonly downloadErrors = new Map<string, GoogleApiError>();
  failIndexWrites = false;
  private nextId = 1;
  private clock = Date.parse("2026-10-01T00:00:00Z");

  /** When set, findFoldersByName reports a partial search. */
  incompleteSearch = false;

  constructor() {
    super({ accessToken: async () => "unused", invalidate: () => {} });
  }

  addFolder(name: string, parentId: string | null, opts: { owner?: DriveUser; capabilities?: DriveCapabilities } = {}): DriveFile {
    return this.add({
      name,
      mimeType: FOLDER_MIME,
      parents: parentId ? [parentId] : [],
      owners: [opts.owner ?? ME],
      capabilities: opts.capabilities ?? OWNER_FOLDER,
      content: null,
    });
  }

  addFile(
    name: string,
    parentId: string,
    content: Uint8Array,
    opts: { owner?: DriveUser; capabilities?: DriveCapabilities; mimeType?: string } = {},
  ): DriveFile {
    return this.add({
      name,
      mimeType: opts.mimeType ?? "font/ttf",
      parents: [parentId],
      owners: [opts.owner ?? ME],
      capabilities: opts.capabilities ?? caps({ canTrash: true, canEdit: true }),
      content,
    });
  }

  setContent(id: string, content: Uint8Array): void {
    const node = this.node(id);
    node.content = content;
    node.md5Checksum = md5(content);
    node.size = content.byteLength;
    node.modifiedTime = this.tick();
  }

  count(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }

  override async about(): Promise<{ email: string; name: string | null }> {
    this.calls.push("about");
    return { email: this.me.emailAddress ?? "", name: this.me.displayName };
  }

  override async findFoldersByName(name: string): Promise<{ files: DriveFile[]; incomplete: boolean }> {
    this.calls.push(`find:${name}`);
    const files = [...this.nodes.values()]
      .filter((node) => node.mimeType === FOLDER_MIME && node.name === name && !node.trashed)
      .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
      .map(strip);
    return { files, incomplete: this.incompleteSearch };
  }

  override async getFile(id: string): Promise<DriveFile> {
    this.calls.push(`get:${id}`);
    return strip(this.node(id));
  }

  override async createFolder(name: string): Promise<DriveFile> {
    this.calls.push(`createFolder:${name}`);
    return this.addFolder(name, "root", { owner: this.me });
  }

  override async listChildren(folder: DriveFile): Promise<DriveFile[]> {
    this.calls.push(`list:${folder.id}`);
    return [...this.nodes.values()].filter((node) => node.parents.includes(folder.id) && !node.trashed).map(strip);
  }

  override async download(id: string): Promise<Uint8Array> {
    this.calls.push(`download:${id}`);
    const error = this.downloadErrors.get(id);
    if (error) throw error;
    const content = this.node(id).content;
    if (!content) throw new GoogleApiError(403, "fileNotDownloadable", "Only files with binary content can be downloaded.");
    return content.slice();
  }

  override async upload(input: { name: string; parentId: string; bytes: Uint8Array; mimeType: string }): Promise<DriveFile> {
    this.calls.push(`upload:${input.name}`);
    if (this.failIndexWrites && input.mimeType === "application/json") throw new GoogleApiError(500, null, "Backend error");
    if (!this.node(input.parentId).capabilities.canAddChildren) {
      throw new GoogleApiError(403, "insufficientFilePermissions", "The user does not have sufficient permissions for this file.");
    }
    return this.addFile(input.name, input.parentId, input.bytes.slice(), { owner: this.me, mimeType: input.mimeType });
  }

  override async updateContent(id: string, bytes: Uint8Array, _mimeType: string): Promise<DriveFile> {
    this.calls.push(`updateContent:${id}`);
    if (this.failIndexWrites) throw new GoogleApiError(500, null, "Backend error");
    this.setContent(id, bytes.slice());
    return strip(this.node(id));
  }

  override async trash(id: string): Promise<void> {
    this.calls.push(`trash:${id}`);
    this.node(id).trashed = true;
  }

  override async removeParent(fileId: string, parentId: string): Promise<void> {
    this.calls.push(`removeParent:${fileId}:${parentId}`);
    const node = this.node(fileId);
    node.parents = node.parents.filter((parent) => parent !== parentId);
  }

  override async listPermissions(id: string): Promise<DrivePermission[]> {
    this.calls.push(`permissions:${id}`);
    return this.permissions;
  }

  private add(input: Pick<Node, "name" | "mimeType" | "parents" | "owners" | "capabilities" | "content">): DriveFile {
    const id = `id${this.nextId++}`;
    const node: Node = {
      id,
      driveId: null,
      size: input.content?.byteLength ?? null,
      md5Checksum: input.content ? md5(input.content) : null,
      modifiedTime: this.tick(),
      webViewLink: `https://drive.google.com/open?id=${id}`,
      trashed: false,
      lastModifyingUser: input.owners[0] ?? null,
      ...input,
    };
    this.nodes.set(id, node);
    return strip(node);
  }

  private node(id: string): Node {
    const node = this.nodes.get(id);
    if (!node) throw new GoogleApiError(404, "notFound", `File not found: ${id}.`);
    return node;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

function strip(node: Node): DriveFile {
  const { content: _content, ...file } = node;
  return structuredClone(file);
}

export class MemoryStore<T> implements Store<T> {
  writes = 0;

  constructor(public value: T) {}

  async read(): Promise<T> {
    return structuredClone(this.value);
  }

  async write(value: T): Promise<void> {
    this.value = structuredClone(value);
    this.writes++;
  }

  async update(fn: (draft: T) => T | void): Promise<T> {
    const draft = structuredClone(this.value);
    this.value = (fn(draft) as T | undefined) ?? draft;
    this.writes++;
    return structuredClone(this.value);
  }
}

/** Records the order of install and uninstall calls. With `dir`, writes real files so their paths exist. */
export class FakeInstaller implements Installer {
  readonly log: string[] = [];
  readonly installs: InstallInput[] = [];
  pendingDeletes: string[] = [];
  installError: Error | null = null;

  constructor(private readonly dir: string | null = null) {}

  async install(input: InstallInput): Promise<InstalledFont> {
    if (this.installError) throw this.installError;
    this.log.push(`install:${input.md5}`);
    this.installs.push(input);
    const path = `${this.dir ?? "/nonexistent/fonts"}/${input.md5}.${input.format}`;
    if (this.dir) await Bun.write(path, input.bytes);
    return { paths: [path], registryValues: [] };
  }

  async uninstall(installed: InstalledFont): Promise<{ pendingDeletes: string[] }> {
    this.log.push(`uninstall:${installed.paths.join(",")}`);
    return { pendingDeletes: this.pendingDeletes };
  }

  async retryPendingDeletes(paths: string[]): Promise<string[]> {
    return paths;
  }
}

export function setup(opts: { libraryFolderId?: string | null; localFonts?: LocalFace[]; installerDir?: string } = {}) {
  const clock = { now: new Date("2026-10-07T12:00:00Z") };
  const drive = new FakeDrive();
  const installer = new FakeInstaller(opts.installerDir ?? null);
  const config = new MemoryStore<Config>({ libraryFolderId: opts.libraryFolderId ?? null, pairedClients: [] });
  const installed = new MemoryStore<InstalledState>({ files: {}, pendingDeletes: [] });
  const facesCache = new MemoryStore<FacesCache>({});
  const local: { fonts: LocalFace[] } = { fonts: opts.localFonts ?? [] };
  const library = new Library({
    drive,
    installer,
    config,
    installed,
    facesCache,
    localFonts: async () => local.fonts,
    now: () => clock.now,
  });
  return { library, drive, installer, config, installed, facesCache, local, clock };
}
