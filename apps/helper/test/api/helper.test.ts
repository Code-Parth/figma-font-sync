import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveGoogleClient } from "../../src/config/google-client";
import type { SecretStore } from "../../src/config/secrets";
import { openConfig } from "../../src/config/store";
import { createHelper, createQueue, expiringMemo, type Helper, type HelperOptions } from "../../src/helper";

const CLIENT_ENV = { FONT_SYNC_GOOGLE_CLIENT_ID: "test-client", FONT_SYNC_GOOGLE_CLIENT_SECRET: "test-secret" };

function memorySecrets(initial: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => {
      values.delete(name);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Google, faked by URL. Anything unexpected fails loudly. */
function fakeGoogle(routes: {
  token: (params: URLSearchParams) => Response;
  drive: (url: URL, authorization: string | null) => Response;
}): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
      return routes.token(new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : undefined));
    }
    if (url.hostname === "www.googleapis.com") return routes.drive(url, new Headers(init?.headers).get("authorization"));
    throw new Error(`unexpected fetch ${url.href}`);
  };
  return impl as typeof fetch;
}

const ADA = { emailAddress: "ada@example.com", displayName: "Ada" };
const GRACE = { emailAddress: "grace@example.com", displayName: "Grace" };

/** One access token per refresh token, and the account behind each access token. */
function twoAccounts(): typeof fetch {
  return fakeGoogle({
    token: (params) =>
      json({ access_token: `access-for-${params.get("refresh_token")}`, expires_in: 3600, token_type: "Bearer" }),
    drive: (url, authorization) => {
      if (!url.pathname.endsWith("/about")) return json({ files: [] });
      return json({ user: authorization === "Bearer access-for-refresh-b" ? GRACE : ADA });
    },
  });
}

describe("createHelper", () => {
  let home: string;
  let quiet: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "font-sync-helper-"));
    quiet = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    quiet.mockRestore();
    await rm(home, { recursive: true, force: true });
  });

  const configDir = () => join(home, "Library", "Application Support", "font-sync");

  function options(overrides: Partial<HelperOptions> = {}): HelperOptions {
    return {
      platform: "darwin",
      env: CLIENT_ENV,
      home,
      openUrl: async () => {
        throw new Error("no browser in tests");
      },
      secrets: memorySecrets(),
      fetch: fakeGoogle({
        token: () => json({ error: "unexpected" }, 500),
        drive: () => json({ error: "unexpected" }, 500),
      }),
      ...overrides,
    };
  }

  it("reports signed-out without a stored refresh token", async () => {
    const helper = await createHelper(options());
    expect(await helper.status()).toEqual({
      version: helper.version,
      platform: "darwin",
      auth: "signed-out",
      account: null,
      library: null,
      libraryError: null,
    });
  });

  it("keeps /status working when Google fails", async () => {
    await createHelper(options()); // creates the config directory
    await writeFile(join(configDir(), "config.json"), JSON.stringify({ libraryFolderId: "lib1", pairedClients: [] }));
    const helper = await createHelper(
      options({
        secrets: memorySecrets({ "google-refresh-token": "refresh" }),
        fetch: fakeGoogle({
          token: () => json({ access_token: "access", expires_in: 3600, token_type: "Bearer" }),
          drive: (url) =>
            url.pathname.endsWith("/about")
              ? json({ user: { emailAddress: "ada@example.com", displayName: "Ada" } })
              : json({ error: { code: 403, message: "nope", errors: [{ reason: "forbidden" }] } }, 403),
        }),
      }),
    );
    const status = await helper.status();
    expect(status.auth).toBe("signed-in");
    expect(status.account).toEqual({ email: "ada@example.com", name: "Ada" });
    expect(status.library).toBeNull();
    expect(status.libraryError).toContain("nope");
  });

  it("notices a revoked grant through a Drive 401, not only at the next token refresh", async () => {
    await createHelper(options()); // creates the config directory
    await writeFile(join(configDir(), "config.json"), JSON.stringify({ libraryFolderId: "lib1", pairedClients: [] }));
    let revoked = false;
    const helper = await createHelper(
      options({
        secrets: memorySecrets({ "google-refresh-token": "refresh" }),
        fetch: fakeGoogle({
          token: () =>
            revoked
              ? json({ error: "invalid_grant" }, 400)
              : json({ access_token: "access", expires_in: 3600, token_type: "Bearer" }),
          drive: (url) => {
            if (revoked) return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
            return url.pathname.endsWith("/about")
              ? json({ user: ADA })
              : json({ error: { code: 403, message: "nope", errors: [{ reason: "forbidden" }] } }, 403);
          },
        }),
      }),
    );
    expect((await helper.status()).auth).toBe("signed-in");
    revoked = true;
    const status = await helper.status();
    expect(status.auth).toBe("expired");
    expect(status.libraryError).toBeNull();
  });

  it("shows an expired sign-in found while reading status", async () => {
    const helper = await createHelper(
      options({
        secrets: memorySecrets({ "google-refresh-token": "revoked" }),
        fetch: fakeGoogle({
          token: () => json({ error: "invalid_grant" }, 400),
          drive: () => json({}, 500),
        }),
      }),
    );
    const status = await helper.status();
    expect(status.auth).toBe("expired");
    expect(status.library).toBeNull();
    // invalid_grant deleted the stored token; finding it gone must not turn "expired" into "signed-out".
    expect((await helper.status()).auth).toBe("expired");
  });

  it("picks up a sign-in stored by another process, with that account", async () => {
    const secrets = memorySecrets();
    const helper = await createHelper(
      options({
        secrets,
        fetch: fakeGoogle({
          token: () => json({ access_token: "access", expires_in: 3600, token_type: "Bearer" }),
          drive: () => json({ user: { emailAddress: "grace@example.com", displayName: "Grace" } }),
        }),
      }),
    );
    expect((await helper.status()).auth).toBe("signed-out");
    await secrets.set("google-refresh-token", "from-cli");
    const status = await helper.status();
    expect(status.auth).toBe("signed-in");
    expect(status.account).toEqual({ email: "grace@example.com", name: "Grace" });
  });

  it("drops a session another process signed out of, before the next Drive call", async () => {
    const secrets = memorySecrets({ "google-refresh-token": "refresh-a" });
    const helper = await createHelper(options({ secrets, fetch: twoAccounts() }));
    expect(await helper.status()).toMatchObject({ auth: "signed-in", account: { email: "ada@example.com" } });

    // `font-sync logout` in another process; this helper still holds a valid access token for Ada.
    await secrets.delete("google-refresh-token");
    await expect(helper.candidates()).rejects.toThrow("Sign in with Google first");
    expect(await helper.status()).toMatchObject({ auth: "signed-out", account: null, library: null });
  });

  it("switches to the account another process signed in as", async () => {
    const secrets = memorySecrets({ "google-refresh-token": "refresh-a" });
    const helper = await createHelper(options({ secrets, fetch: twoAccounts() }));
    expect((await helper.status()).account).toEqual({ email: "ada@example.com", name: "Ada" });

    await secrets.set("google-refresh-token", "refresh-b");
    expect(await helper.status()).toMatchObject({ auth: "signed-in", account: { email: "grace@example.com" } });
  });

  it("retries pending deletes at startup", async () => {
    await createHelper(options());
    const leftover = join(home, "Library", "Fonts", "Old-12345678.ttf");
    await Bun.write(leftover, new Uint8Array([0, 1, 0, 0]));
    const installedPath = join(configDir(), "installed.json");
    await writeFile(installedPath, JSON.stringify({ files: {}, pendingDeletes: [leftover] }));

    await createHelper(options());
    expect(await Bun.file(leftover).exists()).toBe(false);
    expect(JSON.parse(await readFile(installedPath, "utf8")).pendingDeletes).toEqual([]);
  });

  it("keeps a pending file that an installed font uses again, and takes it off the list", async () => {
    await createHelper(options());
    const reused = join(home, "Library", "Fonts", "Inter-Bold-12345678.ttf");
    await Bun.write(reused, new Uint8Array([0, 1, 0, 0]));
    const installedPath = join(configDir(), "installed.json");
    const record = {
      fileId: "file1",
      md5: "12345678",
      name: "Inter-Bold.ttf",
      paths: [reused],
      registryValues: [],
      faces: [],
      installedAt: "2026-10-07T12:00:00.000Z",
    };
    await writeFile(installedPath, JSON.stringify({ files: { file1: record }, pendingDeletes: [reused] }));

    await createHelper(options());
    expect(await Bun.file(reused).exists()).toBe(true);
    expect(JSON.parse(await readFile(installedPath, "utf8")).pendingDeletes).toEqual([]);
  });

  it("pairs against config.json on disk", async () => {
    const helper = await createHelper(options());
    const { code } = helper.pairing.start("Figma");
    const { token } = await helper.pairing.complete(code, "Figma");
    expect(await helper.pairing.verify(token)).not.toBeNull();
    const stored = await readFile(join(configDir(), "config.json"), "utf8");
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored).pairedClients).toHaveLength(1);
  });

  it("reports not-configured with no client in the environment or config.json", async () => {
    const helper = await createHelper(options({ env: {} }));
    expect((await helper.status()).auth).toBe("not-configured");
    await expect(helper.login()).rejects.toThrow("not configured");
  });

  it("signs in with the client stored in config.json", async () => {
    await saveGoogleClient(openConfig(configDir()), { clientId: "config-client", clientSecret: "config-secret" });
    const helper = await createHelper(options({ env: {} }));
    expect((await helper.status()).auth).toBe("signed-out");
    expect(await loginClientId(helper)).toBe("config-client");
  });

  it("prefers the environment's client over config.json", async () => {
    await saveGoogleClient(openConfig(configDir()), { clientId: "config-client", clientSecret: null });
    const helper = await createHelper(options());
    expect(await loginClientId(helper)).toBe("test-client");
  });

  it("adopts a client that setup stores while it runs, with the sign-in already stored", async () => {
    const helper = await createHelper(
      options({
        env: {},
        secrets: memorySecrets({ "google-refresh-token": "refresh" }),
        fetch: fakeGoogle({
          token: (params) =>
            params.get("client_id") === "config-client"
              ? json({ access_token: "access", expires_in: 3600, token_type: "Bearer" })
              : json({ error: "invalid_client" }, 401),
          drive: (url) => (url.pathname.endsWith("/about") ? json({ user: ADA }) : json({ files: [] })),
        }),
      }),
    );
    expect((await helper.status()).auth).toBe("not-configured");
    await saveGoogleClient(openConfig(configDir()), { clientId: "config-client", clientSecret: "config-secret" });
    expect(await helper.status()).toMatchObject({ auth: "signed-in", account: { email: "ada@example.com" } });
  });

  it("adopts a client stored while it runs when sign-in starts before any status call", async () => {
    const helper = await createHelper(options({ env: {} }));
    await saveGoogleClient(openConfig(configDir()), { clientId: "config-client", clientSecret: null });
    expect(await loginClientId(helper)).toBe("config-client");
  });

  it("follows a client that setup replaces while it runs, without a restart", async () => {
    const config = openConfig(configDir());
    await saveGoogleClient(config, { clientId: "client-a", clientSecret: "secret-a" });
    const refreshedWith: (string | null)[] = [];
    const secrets = memorySecrets({ "google-refresh-token": "refresh" });
    const helper = await createHelper(
      options({
        env: {},
        secrets,
        fetch: fakeGoogle({
          token: (params) => {
            refreshedWith.push(`${params.get("client_id")}/${params.get("client_secret")}`);
            return json({ access_token: `access-${refreshedWith.length}`, expires_in: 3600, token_type: "Bearer" });
          },
          drive: (url) => (url.pathname.endsWith("/about") ? json({ user: ADA }) : json({ files: [] })),
        }),
      }),
    );
    expect((await helper.status()).auth).toBe("signed-in");
    await saveGoogleClient(config, { clientId: "client-b", clientSecret: "secret-b" });
    // `setup` signs in again with the new client in its own process.
    await secrets.set("google-refresh-token", "refresh-from-b");
    expect((await helper.status()).auth).toBe("signed-in");
    expect(refreshedWith).toEqual(["client-a/secret-a", "client-b/secret-b"]);
    expect(await loginClientId(helper)).toBe("client-b");
  });

  it("keeps the client a sign-in in progress started with", async () => {
    const config = openConfig(configDir());
    await saveGoogleClient(config, { clientId: "client-a", clientSecret: null });
    const helper = await createHelper(options({ env: {} }));
    const { url, done } = await helper.login();
    await saveGoogleClient(config, { clientId: "client-b", clientSecret: null });
    expect((await helper.status()).auth).toBe("signing-in");

    const params = new URL(url).searchParams;
    expect(params.get("client_id")).toBe("client-a");
    const callback = new URL(params.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({ state: params.get("state") ?? "", error: "access_denied" }).toString();
    await fetch(callback);
    await expect(done).rejects.toThrow("access_denied");
    expect(await loginClientId(helper)).toBe("client-b");
  });

  it("opens the browser only when allowed, and never throws", async () => {
    const opened: string[] = [];
    const quietHelper = await createHelper(
      options({
        env: { ...CLIENT_ENV, FONT_SYNC_NO_BROWSER: "1" },
        openUrl: async (url) => {
          opened.push(url);
        },
      }),
    );
    await quietHelper.openBrowser("http://localhost:47321/pair");
    expect(opened).toEqual([]);

    const failing = await createHelper(options());
    await failing.openBrowser("http://localhost:47321/pair");
    expect(quiet).toHaveBeenCalled();
  });
});

/** Starts sign-in, returns the client id it asks Google for, and cancels it so its loopback listener closes. */
async function loginClientId(helper: Helper): Promise<string | null> {
  const { url, done } = await helper.login();
  const params = new URL(url).searchParams;
  const callback = new URL(params.get("redirect_uri") ?? "");
  callback.search = new URLSearchParams({ state: params.get("state") ?? "", error: "access_denied" }).toString();
  await fetch(callback);
  await expect(done).rejects.toThrow("access_denied");
  return params.get("client_id");
}

describe("createQueue", () => {
  it("runs tasks one at a time and survives a failure", async () => {
    const serialize = createQueue();
    const log: string[] = [];
    const task = (name: string, ms: number, fail = false) => async () => {
      log.push(`start ${name}`);
      await Bun.sleep(ms);
      log.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([
      serialize(task("a", 5)),
      serialize(task("b", 1, true)),
      serialize(task("c", 1)),
    ]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("expiringMemo", () => {
  it("reuses a load until it expires or is invalidated", async () => {
    let now = 0;
    let loads = 0;
    const memo = expiringMemo(async () => ++loads, 30_000, () => now);
    expect(await memo.get()).toBe(1);
    now = 29_999;
    expect(await memo.get()).toBe(1);
    now = 30_000;
    expect(await memo.get()).toBe(2);
    memo.invalidate();
    expect(await memo.get()).toBe(3);
  });

  it("does not remember a failed load", async () => {
    let fail = true;
    const memo = expiringMemo(async () => {
      if (fail) throw new Error("scan failed");
      return "ok";
    }, 30_000);
    await expect(memo.get()).rejects.toThrow("scan failed");
    fail = false;
    expect(await memo.get()).toBe("ok");
  });
});
