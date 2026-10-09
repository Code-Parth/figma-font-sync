import { describe, expect, test } from "bun:test";
import { DriveClient, type DriveFile, FOLDER_MIME, GoogleApiError } from "../../src/google/drive";
import { GoogleAuth } from "../../src/google/oauth";
import { type FakeRequest, type Handler, MemorySecrets, fakeFetch, googleError, json } from "./support";

const FILES = "/drive/v3/files";
const UPLOAD = "/upload/drive/v3/files";

function client(routes: Record<string, Handler | Handler[]>) {
  const google = fakeFetch(routes);
  const drive = new DriveClient({ accessToken: async () => "token-abc", invalidate: () => {} }, google.fetch, () => 0);
  return { drive, requests: google.requests };
}

function folder(id: string, driveId: string | null = null): DriveFile {
  return {
    id,
    name: "font-sync-figma-plugin",
    mimeType: FOLDER_MIME,
    driveId,
    size: null,
    md5Checksum: null,
    modifiedTime: "2026-10-01T10:00:00.000Z",
    parents: [],
    webViewLink: null,
    trashed: false,
    owners: [],
    lastModifyingUser: null,
    capabilities: {
      canAddChildren: true,
      canListChildren: true,
      canEdit: true,
      canTrash: false,
      canRemoveChildren: true,
      canDownload: true,
    },
  };
}

function rawFile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.ttf`,
    mimeType: "font/ttf",
    size: "1234",
    md5Checksum: "0123456789abcdef0123456789abcdef",
    modifiedTime: "2026-10-01T10:00:00.000Z",
    parents: ["folder-1"],
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    owners: [{ emailAddress: "a@example.com", displayName: "A" }],
    lastModifyingUser: { emailAddress: "a@example.com", displayName: "A" },
    capabilities: { canTrash: true, canEdit: true, canDownload: true },
    ...overrides,
  };
}

function text(request: FakeRequest): string {
  return new TextDecoder().decode(request.body);
}

describe("listing", () => {
  test("listChildren follows nextPageToken with one fields mask, the all-drives flags and the user corpus", async () => {
    const { drive, requests } = client({
      [`GET ${FILES}`]: () => json({ files: [rawFile("a"), rawFile("b", { md5Checksum: undefined })], nextPageToken: "p2" }),
      [`GET ${FILES}?pageToken=p2`]: () => json({ files: [rawFile("c")] }),
    });

    const files = await drive.listChildren(folder("folder-1"));
    expect(files.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(requests).toHaveLength(2);

    const first = requests[0]!;
    expect(first.headers.get("Authorization")).toBe("Bearer token-abc");
    const query = first.url.searchParams;
    expect(query.get("q")).toBe("'folder-1' in parents and trashed = false");
    expect(query.get("pageSize")).toBe("1000");
    expect(query.get("supportsAllDrives")).toBe("true");
    expect(query.get("includeItemsFromAllDrives")).toBe("true");
    // A My Drive folder is searched in the user corpus, not allDrives, which Google may cut short.
    expect(query.get("corpora")).toBe("user");
    expect(query.get("driveId")).toBeNull();
    expect(query.get("pageToken")).toBeNull();
    const fields = query.get("fields") ?? "";
    expect(fields.startsWith("nextPageToken,incompleteSearch,files(")).toBe(true);
    for (const field of ["md5Checksum", "size", "parents", "webViewLink", "owners(", "capabilities(", "canAddChildren", "driveId"]) {
      expect(fields).toContain(field);
    }
    expect(requests[1]!.url.searchParams.get("q")).toBe(query.get("q"));

    // Drive sends int64 as strings and leaves out what it does not have.
    expect(files[0]).toMatchObject({ size: 1234, parents: ["folder-1"], trashed: false });
    expect(files[0]!.capabilities).toEqual({
      canAddChildren: false,
      canListChildren: false,
      canEdit: true,
      canTrash: true,
      canRemoveChildren: false,
      canDownload: true,
    });
    expect(files[1]!.md5Checksum).toBeNull();
    expect(files[0]!.driveId).toBeNull();
  });

  test("listChildren searches a shared-drive folder in its own drive", async () => {
    const { drive, requests } = client({ [`GET ${FILES}`]: () => json({ files: [rawFile("a", { driveId: "sd-1" })] }) });
    const files = await drive.listChildren(folder("folder-1", "sd-1"));
    expect(files[0]!.driveId).toBe("sd-1");
    const query = requests[0]!.url.searchParams;
    expect(query.get("corpora")).toBe("drive");
    expect(query.get("driveId")).toBe("sd-1");
  });

  test("listChildren refuses a listing Google reports as partial, on any page", async () => {
    const { drive } = client({
      [`GET ${FILES}`]: () => json({ files: [rawFile("a")], nextPageToken: "p2" }),
      [`GET ${FILES}?pageToken=p2`]: () => json({ files: [rawFile("b")], incompleteSearch: true }),
    });
    const error = await drive.listChildren(folder("folder-1")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 503, reason: "incompleteSearch" });
  });

  test("findFoldersByName escapes quotes and backslashes, searches all drives and sorts newest first", async () => {
    const { drive, requests } = client({ [`GET ${FILES}`]: () => json({ files: [] }) });
    expect(await drive.findFoldersByName("it's a \\ test")).toEqual({ files: [], incomplete: false });
    expect(requests).toHaveLength(1);
    const query = requests[0]!.url.searchParams;
    expect(query.get("q")).toBe(`name = 'it\\'s a \\\\ test' and mimeType = '${FOLDER_MIME}' and trashed = false`);
    expect(query.get("orderBy")).toBe("modifiedTime desc");
    expect(query.get("corpora")).toBe("allDrives");
  });

  test("findFoldersByName adds My Drive and Shared with me when the all-drives search is partial", async () => {
    const older = { modifiedTime: "2026-09-01T10:00:00.000Z" };
    const newer = { modifiedTime: "2026-10-02T10:00:00.000Z" };
    const { drive, requests } = client({
      [`GET ${FILES}?corpora=allDrives`]: () => json({ files: [rawFile("in-shared-drive", older)], incompleteSearch: true }),
      [`GET ${FILES}?corpora=user`]: () => json({ files: [rawFile("mine", newer), rawFile("in-shared-drive", older)] }),
    });
    const { files, incomplete } = await drive.findFoldersByName("font-sync-figma-plugin");
    expect(files.map((f) => f.id)).toEqual(["mine", "in-shared-drive"]);
    // Shared drives the search skipped can still hold a library folder.
    expect(incomplete).toBe(true);
    expect(requests.map((r) => r.url.searchParams.get("corpora"))).toEqual(["allDrives", "user"]);
    expect(requests[1]!.url.searchParams.get("q")).toBe(requests[0]!.url.searchParams.get("q"));
  });

  test("listChildren escapes the folder id too", async () => {
    const { drive, requests } = client({ [`GET ${FILES}`]: () => json({ files: [] }) });
    await drive.listChildren(folder("x' or name contains '"));
    expect(requests[0]!.url.searchParams.get("q")).toBe("'x\\' or name contains \\'' in parents and trashed = false");
  });

  test("listPermissions pages through and keeps only known roles and types", async () => {
    const { drive, requests } = client({
      "GET /drive/v3/files/folder-1/permissions": () =>
        json({
          permissions: [
            { id: "1", type: "user", role: "owner", emailAddress: "a@example.com", displayName: "A" },
            { id: "2", type: "user", role: "mystery" },
          ],
          nextPageToken: "n",
        }),
      "GET /drive/v3/files/folder-1/permissions?pageToken=n": () =>
        json({ permissions: [{ id: "3", type: "anyone", role: "reader", deleted: true }] }),
    });
    const permissions = await drive.listPermissions("folder-1");
    expect(permissions).toEqual([
      { id: "1", type: "user", role: "owner", emailAddress: "a@example.com", displayName: "A", deleted: false },
      { id: "3", type: "anyone", role: "reader", emailAddress: null, displayName: null, deleted: true },
    ]);
    expect(requests[0]!.url.searchParams.get("fields")).toBe(
      "permissions(id,type,role,emailAddress,displayName,deleted),nextPageToken",
    );
  });

  test("about asks only for the user and returns the email", async () => {
    const { drive, requests } = client({
      "GET /drive/v3/about": () => json({ user: { emailAddress: "me@example.com", displayName: "Me" } }),
    });
    expect(await drive.about()).toEqual({ email: "me@example.com", name: "Me" });
    expect(requests[0]!.url.searchParams.get("fields")).toBe("user(emailAddress,displayName)");
  });
});

describe("files", () => {
  test("download returns the bytes of alt=media", async () => {
    const { drive, requests } = client({
      [`GET ${FILES}/f1`]: () => new Response(new Uint8Array([1, 2, 3])),
    });
    expect(await drive.download("f1")).toEqual(new Uint8Array([1, 2, 3]));
    expect(requests[0]!.url.searchParams.get("alt")).toBe("media");
    expect(requests[0]!.url.searchParams.get("supportsAllDrives")).toBe("true");
  });

  test("createFolder posts folder metadata", async () => {
    const { drive, requests } = client({
      [`POST ${FILES}`]: () => json(rawFile("new", { mimeType: FOLDER_MIME, name: "lib" })),
    });
    const folder = await drive.createFolder("lib");
    expect(folder.id).toBe("new");
    expect(JSON.parse(text(requests[0]!))).toEqual({ name: "lib", mimeType: FOLDER_MIME });
  });

  test("trash and removeParent are PATCHes", async () => {
    const { drive, requests } = client({ [`PATCH ${FILES}/f1`]: () => json({ id: "f1" }) });
    await drive.trash("f1");
    await drive.removeParent("f1", "folder-1");
    expect(JSON.parse(text(requests[0]!))).toEqual({ trashed: true });
    expect(requests[1]!.url.searchParams.get("removeParents")).toBe("folder-1");
    expect(requests[1]!.url.searchParams.get("supportsAllDrives")).toBe("true");
  });

  test("updateContent replaces bytes with uploadType=media", async () => {
    const { drive, requests } = client({ [`PATCH ${UPLOAD}/idx`]: () => json(rawFile("idx")) });
    await drive.updateContent("idx", new TextEncoder().encode("{}"), "application/json");
    const request = requests[0]!;
    expect(request.url.searchParams.get("uploadType")).toBe("media");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(text(request)).toBe("{}");
  });
});

describe("upload", () => {
  test("up to 5 MB is one multipart/related request: JSON metadata, then the bytes", async () => {
    const { drive, requests } = client({ [`POST ${UPLOAD}`]: () => json(rawFile("up-1")) });
    const bytes = new Uint8Array([0, 1, 2, 0xff, 0x0d, 0x0a]);
    const file = await drive.upload({ name: "Inter.ttf", parentId: "folder-1", bytes, mimeType: "font/ttf" });
    expect(file.id).toBe("up-1");

    const request = requests[0]!;
    expect(request.url.searchParams.get("uploadType")).toBe("multipart");
    const boundary = /^multipart\/related; boundary=(.+)$/.exec(request.headers.get("Content-Type") ?? "")?.[1];
    expect(boundary).toBeDefined();

    const head =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `{"name":"Inter.ttf","parents":["folder-1"],"mimeType":"font/ttf"}\r\n` +
      `--${boundary}\r\nContent-Type: font/ttf\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const encoder = new TextEncoder();
    const expected = new Uint8Array([...encoder.encode(head), ...bytes, ...encoder.encode(tail)]);
    expect(request.body).toEqual(expected);
  });

  test("above 5 MB uses a resumable session and resumes from the Range a 308 reports", async () => {
    const total = 9 * 1024 * 1024 + 1;
    const bytes = new Uint8Array(total).map((_, i) => i % 251);
    const { drive, requests } = client({
      [`POST ${UPLOAD}`]: () => new Response(null, { status: 200, headers: { Location: "https://upload.test/session/1" } }),
      // Google kept only the first 4 MiB of the first 8 MiB chunk.
      "PUT /session/1": [
        () => new Response(null, { status: 308, headers: { Range: "bytes=0-4194303" } }),
        () => json(rawFile("big")),
      ],
    });

    const file = await drive.upload({ name: "Big.otf", parentId: "folder-1", bytes, mimeType: "font/otf" });
    expect(file.id).toBe("big");

    const [start, first, second] = requests;
    expect(start!.url.searchParams.get("uploadType")).toBe("resumable");
    expect(start!.headers.get("X-Upload-Content-Type")).toBe("font/otf");
    expect(start!.headers.get("X-Upload-Content-Length")).toBe(String(total));
    expect(JSON.parse(text(start!))).toEqual({ name: "Big.otf", parents: ["folder-1"], mimeType: "font/otf" });

    expect(first!.headers.get("Content-Range")).toBe(`bytes 0-8388607/${total}`);
    expect(first!.body.byteLength).toBe(8 * 1024 * 1024);
    expect(second!.headers.get("Content-Range")).toBe(`bytes 4194304-${total - 1}/${total}`);
    expect(second!.body).toEqual(bytes.subarray(4194304));
  });
});

describe("errors and retries", () => {
  test("retries 429 and then succeeds", async () => {
    const { drive, requests } = client({
      [`GET ${FILES}/f1`]: [() => googleError(429, "rateLimitExceeded", "Slow down"), () => json(rawFile("f1"))],
    });
    expect((await drive.getFile("f1")).id).toBe("f1");
    expect(requests).toHaveLength(2);
  });

  test("retries a 403 rate limit, which Drive also uses for quota", async () => {
    const { drive, requests } = client({
      [`GET ${FILES}/f1`]: [() => googleError(403, "userRateLimitExceeded", "Quota"), () => json(rawFile("f1"))],
    });
    expect((await drive.getFile("f1")).id).toBe("f1");
    expect(requests).toHaveLength(2);
  });

  test("gives up after three 5xx answers", async () => {
    const { drive, requests } = client({ [`GET ${FILES}/f1`]: () => new Response("Bad gateway", { status: 502 }) });
    const error = await drive.getFile("f1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 502, reason: null, message: "Google Drive returned HTTP 502" });
    expect(requests).toHaveLength(3);
  });

  test("does not retry other client errors and keeps Google's reason and message", async () => {
    const { drive, requests } = client({
      [`GET ${FILES}/gone`]: () => googleError(404, "notFound", "File not found: gone."),
      [`GET ${FILES}/denied`]: () => googleError(403, "insufficientFilePermissions", "No access."),
      [`GET ${FILES}/stale`]: () => googleError(401, "authError", "Invalid Credentials"),
    });
    await expect(drive.getFile("gone")).rejects.toMatchObject({
      status: 404,
      reason: "notFound",
      message: "File not found: gone.",
    });
    await expect(drive.getFile("denied")).rejects.toMatchObject({ status: 403, reason: "insufficientFilePermissions" });
    await expect(drive.getFile("stale")).rejects.toMatchObject({ status: 401, reason: "authError" });
    // The 401 is tried once more with a refreshed token.
    expect(requests).toHaveLength(4);
  });

  test("a 401 drops the rejected token and retries once with a fresh one", async () => {
    const issued = ["stale", "fresh", "never"];
    const invalidated: string[] = [];
    let current = issued.shift() ?? "";
    const google = fakeFetch({
      [`GET ${FILES}/f1`]: (request) =>
        request.headers.get("Authorization") === "Bearer fresh"
          ? json(rawFile("f1"))
          : googleError(401, "authError", "Invalid Credentials"),
      [`GET ${FILES}/f2`]: () => googleError(401, "authError", "Invalid Credentials"),
    });
    const tokens = {
      accessToken: async () => current,
      invalidate: (token: string) => {
        invalidated.push(token);
        current = issued.shift() ?? "";
      },
    };
    const drive = new DriveClient(tokens, google.fetch, () => 0);

    expect((await drive.getFile("f1")).id).toBe("f1");
    expect(invalidated).toEqual(["stale"]);
    expect(google.requests.map((r) => r.headers.get("Authorization"))).toEqual(["Bearer stale", "Bearer fresh"]);

    // Still 401 with a fresh token: the grant itself is the problem, so no third request.
    await expect(drive.getFile("f2")).rejects.toMatchObject({ status: 401 });
    expect(invalidated).toEqual(["stale", "fresh"]);
    expect(google.requests).toHaveLength(4);
  });

  test("a revoked grant moves sign-in to expired instead of reusing the dead access token", async () => {
    const secrets = new MemorySecrets();
    secrets.values.set("google-refresh-token", "refresh-1");
    const google = fakeFetch({
      "POST /token": [
        () => json({ access_token: "access-1", expires_in: 3600 }),
        () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
      ],
      // The user removes Font Sync from their Google account after the first call.
      [`GET ${FILES}/f1`]: [() => json(rawFile("f1")), () => googleError(401, "authError", "Invalid Credentials")],
    });
    const auth = new GoogleAuth({
      client: { clientId: "client-123", clientSecret: null },
      secrets,
      openUrl: async () => {},
      fetch: google.fetch,
    });
    await auth.init();
    const drive = new DriveClient(
      { accessToken: () => auth.accessToken(), invalidate: (token) => auth.invalidateAccessToken(token) },
      google.fetch,
      () => 0,
    );

    expect((await drive.getFile("f1")).id).toBe("f1");
    await expect(drive.getFile("f1")).rejects.toMatchObject({ code: "not-signed-in" });
    expect(auth.state()).toBe("expired");
    expect(google.requests.filter((r) => r.url.pathname === "/token")).toHaveLength(2);
  });

  test("a network failure becomes a GoogleApiError", async () => {
    const { drive } = client({
      [`GET ${FILES}/f1`]: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(drive.getFile("f1")).rejects.toMatchObject({ name: "GoogleApiError", status: 0 });
  });
});
