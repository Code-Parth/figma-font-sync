import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { listLibraryFilesQueryKey } from "../../src/ui/api/@tanstack/react-query.gen";
import type { FontKey, LibraryFiles, ResolvedFont } from "../../src/ui/api/types.gen";
import { configureClient } from "../../src/ui/connection";
import { resolveAgainstFreshListing } from "../../src/ui/queries";

const listing: LibraryFiles = { files: [], syncedAt: "2026-10-07T09:00:00.000Z" };

function answer(font: FontKey): ResolvedFont {
  return { ...font, library: null, local: { onDisk: false, installedBySync: false, uploadable: false } };
}

/** Answers like the helper and records each request as "METHOD /path?query". */
function stubHelper(options: { listStatus?: number } = {}) {
  const requests: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (request: Request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/library/files") {
      return options.listStatus
        ? Response.json({ error: { code: "google-error", message: "Drive is unavailable." } }, { status: options.listStatus })
        : Response.json(listing);
    }
    const { fonts } = (await request.json()) as { fonts: FontKey[] };
    return Response.json({ fonts: fonts.map(answer) });
  }) as unknown as typeof fetch);
  return { requests, spy };
}

let stub: ReturnType<typeof stubHelper> | null = null;

beforeAll(() => configureClient());
afterEach(() => {
  stub?.spy.mockRestore();
  stub = null;
});

describe("resolveAgainstFreshListing", () => {
  const fonts: FontKey[] = [{ family: "Roobert", style: "Heavy" }];

  test("re-lists the library folder before resolving, and caches the new listing", async () => {
    stub = stubHelper();
    const queryClient = new QueryClient();

    const resolved = await resolveAgainstFreshListing(queryClient, fonts);

    expect(stub.requests).toEqual(["GET /library/files?refresh=true", "POST /fonts/resolve"]);
    expect(queryClient.getQueryData<LibraryFiles>(listLibraryFilesQueryKey())).toEqual(listing);
    expect(resolved).toEqual([answer({ family: "Roobert", style: "Heavy" })]);
  });

  test("does not resolve against the old listing when the refresh fails", async () => {
    stub = stubHelper({ listStatus: 502 });
    const queryClient = new QueryClient();

    await expect(resolveAgainstFreshListing(queryClient, fonts)).rejects.toThrow("Drive is unavailable.");
    expect(stub.requests).toEqual(["GET /library/files?refresh=true"]);
    expect(queryClient.getQueryData<LibraryFiles>(listLibraryFilesQueryKey())).toBeUndefined();
  });
});
