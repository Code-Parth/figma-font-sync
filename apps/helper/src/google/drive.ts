export const FOLDER_MIME = "application/vnd.google-apps.folder";

export type DriveUser = { emailAddress: string | null; displayName: string | null };

export type DriveCapabilities = {
  canAddChildren: boolean;
  canListChildren: boolean;
  canEdit: boolean;
  canTrash: boolean;
  canRemoveChildren: boolean;
  canDownload: boolean;
};

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  /** The shared drive the file lives in; null in My Drive. */
  driveId: string | null;
  size: number | null;
  md5Checksum: string | null;
  modifiedTime: string;
  parents: string[];
  webViewLink: string | null;
  /** files.get returns trashed files too, so a library folder in the trash has to be detected. */
  trashed: boolean;
  owners: DriveUser[];
  lastModifyingUser: DriveUser | null;
  capabilities: DriveCapabilities;
};

export type DrivePermission = {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader";
  emailAddress: string | null;
  displayName: string | null;
  deleted: boolean;
};

/** Google returned a non-2xx response. `reason` is errors[0].reason when present. */
export class GoogleApiError extends Error {
  override name = "GoogleApiError";
  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
  }
}

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

const USER_FIELDS = "emailAddress,displayName";
const FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "driveId",
  "size",
  "md5Checksum",
  "modifiedTime",
  "parents",
  "webViewLink",
  "trashed",
  `owners(${USER_FIELDS})`,
  `lastModifyingUser(${USER_FIELDS})`,
  "capabilities(canAddChildren,canListChildren,canEdit,canTrash,canRemoveChildren,canDownload)",
].join(",");
const PERMISSION_FIELDS = "permissions(id,type,role,emailAddress,displayName,deleted),nextPageToken";

const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
/** Resumable chunks must be multiples of 256 KiB. */
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
// Drive reports some quota errors as 403 rather than 429; Google's guidance is to back off on these too.
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

const PERMISSION_TYPES: readonly DrivePermission["type"][] = ["user", "group", "domain", "anyone"];
const PERMISSION_ROLES: readonly DrivePermission["role"][] = [
  "owner",
  "organizer",
  "fileOrganizer",
  "writer",
  "commenter",
  "reader",
];

type DriveRequest = {
  method: string;
  url: string;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  /** Statuses that are not errors for this call, besides 2xx (308 during a resumable upload). */
  accept?: number[];
};

export type TokenSource = {
  accessToken(): Promise<string>;
  /** Drive answered 401 to `token`; drop it so the next accessToken() refreshes. */
  invalidate(token: string): void;
};

/**
 * Drive v3 over fetch. Every request sends supportsAllDrives=true, lists send
 * includeItemsFromAllDrives=true, and every call requests an explicit `fields` mask.
 * Retries 429 and 5xx with exponential backoff (3 attempts), and a 401 once with a refreshed token.
 */
export class DriveClient {
  constructor(
    private readonly tokens: TokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Delay before retry number `attempt` (1-based). Injectable so tests do not sleep. */
    private readonly retryDelayMs: (attempt: number) => number = (attempt) =>
      500 * 2 ** (attempt - 1) + Math.random() * 250,
  ) {}

  async about(): Promise<{ email: string; name: string | null }> {
    // about.get takes no supportsAllDrives parameter.
    const url = withQuery(`${API}/about`, { fields: `user(${USER_FIELDS})` });
    const json = await this.json({ method: "GET", url });
    const user = isRecord(json) && isRecord(json.user) ? json.user : {};
    if (typeof user.emailAddress !== "string") {
      throw new GoogleApiError(502, null, "Google did not return the signed-in account's email address");
    }
    return { email: user.emailAddress, name: str(user.displayName) };
  }

  /**
   * Non-trashed folders with exactly this name that the user can see, owned or shared, newest first.
   * `incomplete`: Google did not search every shared drive, so a folder can be missing.
   */
  async findFoldersByName(name: string): Promise<{ files: DriveFile[]; incomplete: boolean }> {
    const q = `name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    // Only allDrives reaches folders in shared drives, but Google may stop before it has searched them all.
    const all = await this.listFiles({ q, orderBy: "modifiedTime desc", corpora: "allDrives" });
    if (!all.incomplete) return all;
    // Google's advice for a partial allDrives search is a narrower corpus; "user" is My Drive and Shared with me.
    const mine = await this.listFiles({ q, orderBy: "modifiedTime desc", corpora: "user" });
    const seen = new Set(all.files.map((file) => file.id));
    const files = [...all.files, ...mine.files.filter((file) => !seen.has(file.id))].sort((a, b) =>
      a.modifiedTime < b.modifiedTime ? 1 : a.modifiedTime > b.modifiedTime ? -1 : 0,
    );
    return { files, incomplete: true };
  }

  async getFile(id: string): Promise<DriveFile> {
    const url = withQuery(`${API}/files/${encodeURIComponent(id)}`, { fields: FILE_FIELDS, supportsAllDrives: "true" });
    return toDriveFile(await this.json({ method: "GET", url }));
  }

  /** Creates in the user's My Drive root. */
  async createFolder(name: string): Promise<DriveFile> {
    const url = withQuery(`${API}/files`, { fields: FILE_FIELDS, supportsAllDrives: "true" });
    return toDriveFile(
      await this.json({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      }),
    );
  }

  /** Direct, non-trashed children of a folder, searched in the folder's own drive; follows every nextPageToken. */
  async listChildren(folder: DriveFile): Promise<DriveFile[]> {
    const q = `'${escapeQuery(folder.id)}' in parents and trashed = false`;
    const { files, incomplete } = folder.driveId
      ? await this.listFiles({ q, corpora: "drive", driveId: folder.driveId })
      : await this.listFiles({ q, corpora: "user" });
    // A font left out of the listing would show as "Not in library"; failing lets the user try again.
    if (incomplete) {
      throw new GoogleApiError(503, "incompleteSearch", "Google Drive returned a partial folder listing; try again");
    }
    return files;
  }

  async download(id: string): Promise<Uint8Array> {
    const url = withQuery(`${API}/files/${encodeURIComponent(id)}`, { alt: "media", supportsAllDrives: "true" });
    const response = await this.request({ method: "GET", url });
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Multipart upload up to 5 MB, resumable above. */
  async upload(input: { name: string; parentId: string; bytes: Uint8Array; mimeType: string }): Promise<DriveFile> {
    const metadata = JSON.stringify({ name: input.name, parents: [input.parentId], mimeType: input.mimeType });
    if (input.bytes.byteLength <= MULTIPART_MAX_BYTES) {
      const boundary = `font-sync-${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;
      const encoder = new TextEncoder();
      const body = concat([
        encoder.encode(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
            `--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
        ),
        input.bytes,
        encoder.encode(`\r\n--${boundary}--\r\n`),
      ]);
      const url = withQuery(`${UPLOAD_API}/files`, {
        uploadType: "multipart",
        fields: FILE_FIELDS,
        supportsAllDrives: "true",
      });
      return toDriveFile(
        await this.json({
          method: "POST",
          url,
          headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
          body,
        }),
      );
    }

    const start = await this.request({
      method: "POST",
      url: withQuery(`${UPLOAD_API}/files`, { uploadType: "resumable", fields: FILE_FIELDS, supportsAllDrives: "true" }),
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": input.mimeType,
        "X-Upload-Content-Length": String(input.bytes.byteLength),
      },
      body: metadata,
    });
    const session = start.headers.get("Location");
    if (!session) throw new GoogleApiError(502, null, "Google did not return an upload session");
    return this.uploadChunks(session, input.bytes, input.mimeType);
  }

  async updateContent(id: string, bytes: Uint8Array, mimeType: string): Promise<DriveFile> {
    const url = withQuery(`${UPLOAD_API}/files/${encodeURIComponent(id)}`, {
      uploadType: "media",
      fields: FILE_FIELDS,
      supportsAllDrives: "true",
    });
    return toDriveFile(await this.json({ method: "PATCH", url, headers: { "Content-Type": mimeType }, body: bytes }));
  }

  async trash(id: string): Promise<void> {
    const url = withQuery(`${API}/files/${encodeURIComponent(id)}`, { fields: "id", supportsAllDrives: "true" });
    await this.json({
      method: "PATCH",
      url,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  async removeParent(fileId: string, parentId: string): Promise<void> {
    const url = withQuery(`${API}/files/${encodeURIComponent(fileId)}`, {
      removeParents: parentId,
      fields: "id",
      supportsAllDrives: "true",
    });
    await this.json({
      method: "PATCH",
      url,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: "{}",
    });
  }

  async listPermissions(id: string): Promise<DrivePermission[]> {
    const permissions: DrivePermission[] = [];
    let pageToken: string | null = null;
    do {
      const query: Record<string, string> = { fields: PERMISSION_FIELDS, pageSize: "100", supportsAllDrives: "true" };
      if (pageToken) query.pageToken = pageToken;
      const json = await this.json({ method: "GET", url: withQuery(`${API}/files/${encodeURIComponent(id)}/permissions`, query) });
      const page = isRecord(json) ? json : {};
      for (const raw of Array.isArray(page.permissions) ? page.permissions : []) {
        const permission = toPermission(raw);
        if (permission) permissions.push(permission);
      }
      pageToken = str(page.nextPageToken);
    } while (pageToken);
    return permissions;
  }

  private async listFiles(params: {
    q: string;
    orderBy?: string;
    corpora: "user" | "drive" | "allDrives";
    driveId?: string;
  }): Promise<{ files: DriveFile[]; incomplete: boolean }> {
    const files: DriveFile[] = [];
    let incomplete = false;
    let pageToken: string | null = null;
    do {
      const query: Record<string, string> = {
        q: params.q,
        fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
        pageSize: "1000",
        corpora: params.corpora,
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
      };
      if (params.driveId) query.driveId = params.driveId;
      if (params.orderBy) query.orderBy = params.orderBy;
      if (pageToken) query.pageToken = pageToken;
      const json = await this.json({ method: "GET", url: withQuery(`${API}/files`, query) });
      const page = isRecord(json) ? json : {};
      for (const raw of Array.isArray(page.files) ? page.files : []) files.push(toDriveFile(raw));
      incomplete ||= page.incompleteSearch === true;
      pageToken = str(page.nextPageToken);
    } while (pageToken);
    return { files, incomplete };
  }

  private async uploadChunks(session: string, bytes: Uint8Array, mimeType: string): Promise<DriveFile> {
    const total = bytes.byteLength;
    let offset = 0;
    let stalls = 0;
    while (offset < total) {
      const end = Math.min(offset + CHUNK_BYTES, total);
      const response = await this.request({
        method: "PUT",
        url: session,
        headers: { "Content-Type": mimeType, "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
        body: bytes.subarray(offset, end),
        accept: [308],
      });
      if (response.status !== 308) return toDriveFile(await readJson(response));
      // 308 carries the bytes Google has persisted, which can be fewer than were sent.
      const range = /bytes=0-(\d+)/.exec(response.headers.get("Range") ?? "");
      const next = range?.[1] ? Number(range[1]) + 1 : 0;
      stalls = next > offset ? 0 : stalls + 1;
      if (stalls >= MAX_ATTEMPTS) break;
      offset = next;
    }
    throw new GoogleApiError(502, null, "Google did not finish the upload");
  }

  private async json(init: DriveRequest): Promise<unknown> {
    return readJson(await this.request(init));
  }

  private async request(init: DriveRequest): Promise<Response> {
    let reauthorized = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.tokens.accessToken();
      let response: Response;
      try {
        response = await this.fetchImpl(init.url, {
          method: init.method,
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
          body: init.body ?? null,
          // A resumable upload answers 308 without a Location header; fetch must hand it back, not follow it.
          redirect: init.accept?.includes(308) ? "manual" : "follow",
        });
      } catch (error) {
        throw new GoogleApiError(0, null, `Could not reach Google Drive: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok || init.accept?.includes(response.status)) return response;

      const error = await toApiError(response);
      // A revoked grant kills the cached access token before it expires. One retry with a refreshed
      // token either recovers or hits invalid_grant, which moves auth to "expired".
      if (error.status === 401 && !reauthorized) {
        reauthorized = true;
        this.tokens.invalidate(token);
        continue;
      }
      const retryable =
        error.status === 429 || error.status >= 500 || (error.status === 403 && RATE_LIMIT_REASONS.has(error.reason ?? ""));
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      await Bun.sleep(this.retryDelayMs(attempt));
    }
  }
}

function withQuery(base: string, query: Record<string, string>): string {
  return `${base}?${new URLSearchParams(query)}`;
}

/** Drive query strings quote with single quotes and escape with backslashes. */
function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleApiError(502, null, "Google returned a response that is not JSON");
  }
}

async function toApiError(response: Response): Promise<GoogleApiError> {
  const text = await response.text().catch(() => "");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not every failure (proxies, gateways) has a JSON body; the status alone still classifies it.
  }
  const error = isRecord(json) && isRecord(json.error) ? json.error : {};
  const first = Array.isArray(error.errors) && isRecord(error.errors[0]) ? error.errors[0] : {};
  const message = str(error.message) ?? str(first.message) ?? `Google Drive returned HTTP ${response.status}`;
  return new GoogleApiError(response.status, str(first.reason), message);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toUser(value: unknown): DriveUser {
  const user = isRecord(value) ? value : {};
  return { emailAddress: str(user.emailAddress), displayName: str(user.displayName) };
}

function toDriveFile(value: unknown): DriveFile {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new GoogleApiError(502, null, "Google returned a file without an id");
  }
  const caps = isRecord(value.capabilities) ? value.capabilities : {};
  // Drive encodes int64 fields such as size as strings.
  const size = typeof value.size === "string" || typeof value.size === "number" ? Number(value.size) : null;
  return {
    id: value.id,
    name: str(value.name) ?? "",
    mimeType: str(value.mimeType) ?? "",
    driveId: str(value.driveId),
    size: size !== null && Number.isFinite(size) ? size : null,
    md5Checksum: str(value.md5Checksum),
    modifiedTime: str(value.modifiedTime) ?? "",
    parents: Array.isArray(value.parents) ? value.parents.filter((p): p is string => typeof p === "string") : [],
    webViewLink: str(value.webViewLink),
    trashed: value.trashed === true,
    owners: Array.isArray(value.owners) ? value.owners.map(toUser) : [],
    lastModifyingUser: isRecord(value.lastModifyingUser) ? toUser(value.lastModifyingUser) : null,
    capabilities: {
      canAddChildren: caps.canAddChildren === true,
      canListChildren: caps.canListChildren === true,
      canEdit: caps.canEdit === true,
      canTrash: caps.canTrash === true,
      canRemoveChildren: caps.canRemoveChildren === true,
      canDownload: caps.canDownload === true,
    },
  };
}

function toPermission(value: unknown): DrivePermission | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const type = PERMISSION_TYPES.find((t) => t === value.type);
  const role = PERMISSION_ROLES.find((r) => r === value.role);
  if (!type || !role) return null;
  return {
    id: value.id,
    type,
    role,
    emailAddress: str(value.emailAddress),
    displayName: str(value.displayName),
    deleted: value.deleted === true,
  };
}
