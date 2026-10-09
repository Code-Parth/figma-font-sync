import { describe, expect, test } from "bun:test";
import { HelperError } from "../../src/errors";
import { DRIVE_SCOPE, GoogleAuth, type GoogleClientConfig } from "../../src/google/oauth";
import { type FakeRequest, type Handler, MemorySecrets, fakeFetch, form, json } from "./support";

const CLIENT: GoogleClientConfig = { clientId: "client-123.apps.googleusercontent.com", clientSecret: "shh" };
const SECRET = "google-refresh-token";

function tokens(overrides: Record<string, unknown> = {}): Response {
  return json({
    access_token: "access-1",
    expires_in: 3600,
    refresh_token: "refresh-1",
    scope: `${DRIVE_SCOPE} openid`,
    token_type: "Bearer",
    ...overrides,
  });
}

function setup(
  opts: {
    token?: Handler | Handler[];
    revoke?: Handler;
    client?: GoogleClientConfig | null;
    now?: () => number;
    loginTimeoutMs?: number;
  } = {},
) {
  const secrets = new MemorySecrets();
  const opened: string[] = [];
  const google = fakeFetch({
    "POST /token": opts.token ?? (() => tokens()),
    "POST /revoke": opts.revoke ?? (() => new Response(null, { status: 200 })),
  });
  const auth = new GoogleAuth({
    client: opts.client === undefined ? CLIENT : opts.client,
    secrets,
    openUrl: async (url) => {
      opened.push(url);
    },
    fetch: google.fetch,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.loginTimeoutMs ? { loginTimeoutMs: opts.loginTimeoutMs } : {}),
  });
  return { auth, secrets, opened, google };
}

/** Plays the browser: follows Google's redirect back to the loopback listener. */
function callback(authUrl: string, params: Record<string, string>): Promise<Response> {
  const redirect = new URL(authUrl).searchParams.get("redirect_uri") ?? "";
  return fetch(`${redirect}?${new URLSearchParams(params)}`);
}

function stateOf(authUrl: string): string {
  return new URL(authUrl).searchParams.get("state") ?? "";
}

async function signIn(auth: GoogleAuth): Promise<void> {
  const { url, done } = await auth.startLogin();
  await callback(url, { state: stateOf(url), code: "code-1" });
  await done;
}

describe("startLogin", () => {
  test("opens a consent URL with loopback redirect, offline access and PKCE S256", async () => {
    let exchange: FakeRequest | null = null;
    const { auth, opened, secrets } = setup({
      token: (request) => {
        exchange = request;
        return tokens();
      },
    });

    const { url, done } = await auth.startLogin();
    expect(opened).toEqual([url]);
    expect(auth.state()).toBe("signing-in");

    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params = Object.fromEntries(parsed.searchParams);
    expect(params).toMatchObject({
      client_id: CLIENT.clientId,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      code_challenge_method: "S256",
    });
    expect(params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(params.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const response = await callback(url, { state: params.state ?? "", code: "auth-code" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("signed in");
    await done;

    expect(exchange).not.toBeNull();
    const body = form(exchange!);
    expect(body).toEqual({
      client_id: CLIENT.clientId,
      client_secret: "shh",
      code: "auth-code",
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/),
      grant_type: "authorization_code",
      redirect_uri: params.redirect_uri ?? "",
    });
    const challenge = new Bun.CryptoHasher("sha256").update(body.code_verifier ?? "").digest("base64url");
    expect(challenge).toBe(params.code_challenge ?? "");

    expect(auth.state()).toBe("signed-in");
    expect(secrets.values.get(SECRET)).toBe("refresh-1");
    expect(await auth.accessToken()).toBe("access-1");
  });

  test("omits client_secret when the client has none", async () => {
    let exchange: FakeRequest | null = null;
    const { auth } = setup({
      client: { clientId: "public-client", clientSecret: null },
      token: (request) => {
        exchange = request;
        return tokens();
      },
    });
    await signIn(auth);
    expect(form(exchange!).client_secret).toBeUndefined();
  });

  test("rejects a callback with the wrong state and keeps waiting for the real one", async () => {
    const { auth } = setup();
    const { url, done } = await auth.startLogin();

    const forged = await callback(url, { state: "forged", code: "attacker-code" });
    expect(forged.status).toBe(400);
    expect(auth.state()).toBe("signing-in");

    const real = await callback(url, { state: stateOf(url), code: "code-1" });
    expect(real.status).toBe(200);
    await done;
    expect(auth.state()).toBe("signed-in");
  });

  test("answers 404 for any other path", async () => {
    const { auth } = setup();
    const { url, done } = await auth.startLogin();
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    const response = await fetch(`${redirect.origin}/favicon.ico`);
    expect(response.status).toBe(404);
    await callback(url, { state: stateOf(url), error: "access_denied" });
    await done.catch(() => {});
  });

  test("escapes a reflected error parameter and fails the login", async () => {
    const { auth, secrets } = setup();
    const { url, done } = await auth.startLogin();
    const response = await callback(url, { state: stateOf(url), error: "<script>alert(1)</script>" });
    const html = await response.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    await expect(done).rejects.toBeInstanceOf(HelperError);
    expect(auth.state()).toBe("signed-out");
    expect(secrets.values.size).toBe(0);
  });

  test("refuses a grant where the user unticked Drive access", async () => {
    const { auth, secrets } = setup({ token: () => tokens({ scope: "openid email" }) });
    const { url, done } = await auth.startLogin();
    const response = await callback(url, { state: stateOf(url), code: "code-1" });
    expect(await response.text()).toContain("Drive access was not granted");
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect((error as HelperError).message).toContain("Drive access was not granted");
    expect(auth.state()).toBe("signed-out");
    expect(secrets.values.size).toBe(0);
  });

  test("a second startLogin cancels the first", async () => {
    const { auth } = setup();
    const first = await auth.startLogin();
    const second = await auth.startLogin();
    await expect(first.done).rejects.toThrow("restarted");
    expect(stateOf(first.url)).not.toBe(stateOf(second.url));

    const stale = await callback(second.url, { state: stateOf(first.url), code: "old" });
    expect(stale.status).toBe(400);
    await callback(second.url, { state: stateOf(second.url), code: "code-2" });
    await second.done;
    expect(auth.state()).toBe("signed-in");
  });

  test("gives up after the timeout", async () => {
    const { auth } = setup({ loginTimeoutMs: 20 });
    const { done } = await auth.startLogin();
    await expect(done).rejects.toThrow("timed out");
    expect(auth.state()).toBe("signed-out");
  });

  test("is not available without a client", async () => {
    const { auth } = setup({ client: null });
    await auth.init();
    expect(auth.state()).toBe("not-configured");
    await expect(auth.startLogin()).rejects.toMatchObject({ code: "not-configured" });
    await expect(auth.accessToken()).rejects.toMatchObject({ code: "not-configured" });
  });
});

describe("accessToken", () => {
  test("loads the stored refresh token and refreshes with it", async () => {
    let refresh: FakeRequest | null = null;
    const { auth, secrets } = setup({
      token: (request) => {
        refresh = request;
        return json({ access_token: "access-2", expires_in: 3600, scope: DRIVE_SCOPE });
      },
    });
    secrets.values.set(SECRET, "stored-refresh");
    await auth.init();
    expect(auth.state()).toBe("signed-in");

    expect(await auth.accessToken()).toBe("access-2");
    expect(form(refresh!)).toEqual({
      client_id: CLIENT.clientId,
      client_secret: "shh",
      grant_type: "refresh_token",
      refresh_token: "stored-refresh",
    });
  });

  test("reuses the access token until 60 s before it expires", async () => {
    let clock = 1_000_000;
    const { auth, google } = setup({
      now: () => clock,
      token: [() => tokens(), () => json({ access_token: "access-2", expires_in: 3600, scope: DRIVE_SCOPE })],
    });
    await signIn(auth);

    clock += 3539_000;
    expect(await auth.accessToken()).toBe("access-1");
    clock += 2_000;
    expect(await auth.accessToken()).toBe("access-2");
    expect(google.requests.filter((r) => r.url.pathname === "/token")).toHaveLength(2);
  });

  test("concurrent callers share one refresh request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { auth, secrets, google } = setup({
      token: async () => {
        await gate;
        return json({ access_token: "shared", expires_in: 3600 });
      },
    });
    secrets.values.set(SECRET, "stored-refresh");
    await auth.init();

    const calls = [auth.accessToken(), auth.accessToken(), auth.accessToken()];
    release();
    expect(await Promise.all(calls)).toEqual(["shared", "shared", "shared"]);
    expect(google.requests).toHaveLength(1);
  });

  test("invalid_grant deletes the token and moves to expired", async () => {
    const { auth, secrets, google } = setup({
      token: () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
    });
    secrets.values.set(SECRET, "revoked-refresh");
    await auth.init();

    const error = await auth.accessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect(error).toMatchObject({ code: "not-signed-in" });
    expect(auth.state()).toBe("expired");
    expect(secrets.values.has(SECRET)).toBe(false);

    await expect(auth.accessToken()).rejects.toMatchObject({ code: "not-signed-in" });
    expect(google.requests).toHaveLength(1);
  });

  test("invalid_grant leaves a newer token another process stored, and syncStoredToken signs in with it", async () => {
    const secrets = new MemorySecrets();
    secrets.values.set(SECRET, "refresh-a");
    const google = fakeFetch({
      "POST /token": (request) => {
        const body = form(request);
        if (body.grant_type === "authorization_code") return tokens({ refresh_token: "refresh-b", access_token: "access-b" });
        if (body.refresh_token === "refresh-a") return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "access-b2", expires_in: 3600 });
      },
      "POST /revoke": () => new Response(null, { status: 200 }),
    });
    const make = () => new GoogleAuth({ client: CLIENT, secrets, openUrl: async () => {}, fetch: google.fetch });
    const service = make();
    await service.init();

    // The CLI switches accounts while the service still holds refresh-a in memory.
    const cli = make();
    await cli.init();
    await cli.logout();
    await signIn(cli);
    expect(secrets.values.get(SECRET)).toBe("refresh-b");

    await expect(service.accessToken()).rejects.toMatchObject({ code: "not-signed-in" });
    expect(service.state()).toBe("expired");
    expect(secrets.values.get(SECRET)).toBe("refresh-b");

    await service.syncStoredToken();
    expect(service.state()).toBe("signed-in");
    expect(await service.accessToken()).toBe("access-b2");
  });

  test("invalidateAccessToken forces a refresh, but only for the token it names", async () => {
    const { auth, google } = setup({
      token: [() => tokens(), () => json({ access_token: "access-2", expires_in: 3600, scope: DRIVE_SCOPE })],
    });
    await signIn(auth);
    const tokenRequests = () => google.requests.filter((r) => r.url.pathname === "/token").length;

    // A 401 that arrives after a refresh names the old token; the new one must survive it.
    auth.invalidateAccessToken("some-older-token");
    expect(await auth.accessToken()).toBe("access-1");
    expect(tokenRequests()).toBe(1);

    auth.invalidateAccessToken("access-1");
    expect(await auth.accessToken()).toBe("access-2");
    expect(tokenRequests()).toBe(2);
    expect(auth.state()).toBe("signed-in");
  });

  test("other token errors keep the refresh token", async () => {
    const { auth, secrets } = setup({ token: () => json({ error: "internal_failure" }, 500) });
    secrets.values.set(SECRET, "stored-refresh");
    await auth.init();
    await expect(auth.accessToken()).rejects.toMatchObject({ code: "google-error" });
    expect(auth.state()).toBe("signed-in");
    expect(secrets.values.get(SECRET)).toBe("stored-refresh");
  });

  test("throws not-signed-in when signed out", async () => {
    const { auth } = setup();
    await auth.init();
    expect(auth.state()).toBe("signed-out");
    await expect(auth.accessToken()).rejects.toMatchObject({ code: "not-signed-in" });
  });
});

describe("logout", () => {
  test("revokes the refresh token and deletes it", async () => {
    let revoked: FakeRequest | null = null;
    const { auth, secrets } = setup({
      revoke: (request) => {
        revoked = request;
        return new Response(null, { status: 200 });
      },
    });
    secrets.values.set(SECRET, "stored-refresh");
    await auth.init();

    await auth.logout();
    expect(form(revoked!)).toEqual({ token: "stored-refresh" });
    expect(secrets.values.has(SECRET)).toBe(false);
    expect(auth.state()).toBe("signed-out");
    await expect(auth.accessToken()).rejects.toMatchObject({ code: "not-signed-in" });
  });

  test("still signs out when revocation fails", async () => {
    const { auth, secrets } = setup({
      revoke: () => {
        throw new TypeError("network down");
      },
    });
    secrets.values.set(SECRET, "stored-refresh");
    await auth.init();
    await auth.logout();
    expect(secrets.values.has(SECRET)).toBe(false);
    expect(auth.state()).toBe("signed-out");
  });
});

describe("syncStoredToken", () => {
  test("picks up a token another process stored while signed out", async () => {
    const { auth, secrets } = setup();
    await auth.init();
    expect(auth.state()).toBe("signed-out");
    secrets.values.set(SECRET, "from-cli");
    expect(await auth.syncStoredToken()).toBe(true);
    expect(auth.state()).toBe("signed-in");
  });

  test("leaves an expired sign-in expired when nothing new was stored", async () => {
    const { auth, secrets } = setup({ token: () => json({ error: "invalid_grant" }, 400) });
    secrets.values.set(SECRET, "revoked-refresh");
    await auth.init();
    await auth.accessToken().catch(() => undefined);
    expect(await auth.syncStoredToken()).toBe(false);
    expect(auth.state()).toBe("expired");
  });

  test("drops a token another process deleted, with its cached access token", async () => {
    const { auth, secrets } = setup();
    await signIn(auth);
    secrets.values.delete(SECRET);
    expect(await auth.syncStoredToken()).toBe(true);
    expect(auth.state()).toBe("signed-out");
    await expect(auth.accessToken()).rejects.toMatchObject({ code: "not-signed-in" });
  });

  test("adopts a different token another process stored, and refreshes with it", async () => {
    const { auth, secrets, google } = setup({
      token: [() => tokens(), () => json({ access_token: "access-b", expires_in: 3600 })],
    });
    await signIn(auth);
    secrets.values.set(SECRET, "refresh-b");
    expect(await auth.syncStoredToken()).toBe(true);
    expect(await auth.accessToken()).toBe("access-b");
    expect(form(google.requests.at(-1)!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-b" });
    expect(await auth.syncStoredToken()).toBe(false);
  });

  test("a logout during the read wins", async () => {
    const { auth, secrets } = setup();
    secrets.values.set(SECRET, "stored-refresh");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = secrets.get.bind(secrets);
    secrets.get = async (name) => {
      const value = await read(name);
      await gate;
      return value;
    };
    const reload = auth.syncStoredToken();
    await auth.logout();
    release();
    await reload;
    expect(auth.state()).toBe("signed-out");
  });
});
