import { describe, expect, it, spyOn } from "bun:test";
import { createApp, ERROR_STATUS, MAX_REQUEST_BYTES } from "../../src/api/app";
import { ERROR_CODES, HelperError } from "../../src/errors";
import type { Helper } from "../../src/helper";
import { fakeHelper, HOST, manualClock, pairDirectly, PORT, SIGNED_IN } from "./support";

type Init = { method?: string; headers?: Record<string, string>; body?: RequestInit["body"] };

function setup(overrides: Partial<Helper> = {}) {
  const clock = manualClock(Date.now());
  const fake = fakeHelper(overrides, clock);
  const app = createApp(fake.helper, { port: PORT });
  const request = (path: string, init: Init = {}) =>
    app.request(path, { ...init, headers: { host: HOST, ...init.headers } });
  const json = (path: string, body: unknown, init: Init = {}) =>
    request(path, {
      method: "POST",
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify(body),
    });
  return { ...fake, app, request, json };
}

async function authed(overrides: Partial<Helper> = {}) {
  const ctx = setup(overrides);
  const token = await pairDirectly(ctx.pairing);
  ctx.clock.advance(10_000);
  return { ...ctx, auth: { authorization: `Bearer ${token}` }, token };
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return body.error;
}

describe("host check", () => {
  it.each(["localhost:47321", "127.0.0.1:47321", "[::1]:47321", "LOCALHOST:47321"])("accepts %s", async (host) => {
    const { app } = setup();
    const res = await app.request("/health", { headers: { host } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "font-sync", version: "0.0.0-test" });
  });

  it.each(["evil.example:47321", "localhost:1234", "localhost", "127.0.0.1", "localhost:47321.evil.example"])(
    "rejects %s with 421",
    async (host) => {
      const { app } = setup();
      const res = await app.request("/health", { headers: { host } });
      expect(res.status).toBe(421);
      expect((await errorOf(res)).code).toBe("bad-request");
    },
  );

  it("rejects a request without a Host header", async () => {
    const { app } = setup();
    expect((await app.request("/health")).status).toBe(421);
  });

  it("runs before the pairing page and preflight", async () => {
    const { app } = setup();
    expect((await app.request("/pair", { headers: { host: "evil.example:47321" } })).status).toBe(421);
    expect((await app.request("/status", { method: "OPTIONS", headers: { host: "evil.example:47321" } })).status).toBe(421);
  });
});

describe("CORS", () => {
  it("is on API responses, including errors", async () => {
    const { request } = setup();
    for (const res of [await request("/health"), await request("/status"), await request("/nope")]) {
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
      expect(res.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
      expect(res.headers.get("access-control-max-age")).toBe("600");
    }
  });

  it("answers a preflight with 204 and Private Network Access when asked", async () => {
    const { request } = setup();
    const res = await request("/library/install", {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
        "access-control-request-private-network": "true",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("omits Allow-Private-Network when the preflight does not ask", async () => {
    const { request } = setup();
    const res = await request("/status", { method: "OPTIONS", headers: { origin: "null" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-private-network")).toBeNull();
  });
});

describe("GET /pair", () => {
  it("has no CORS headers and sends the security headers", async () => {
    const { request } = setup();
    const res = await request("/pair", { headers: { origin: "null" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    for (const name of res.headers.keys()) expect(name.toLowerCase().startsWith("access-control-")).toBe(false);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("No pairing request is waiting");
  });

  it("shows the pending code, the escaped client name and minutes left", async () => {
    const { request, pairing } = setup();
    const { code } = pairing.start('<img src=x onerror="alert(1)">');
    const html = await (await request("/pair")).text();
    expect(html).toContain(code);
    expect(html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
    expect(html).not.toContain("<img");
    expect(html).toContain("5 minutes");
  });

  it("stays public while DELETE /pair needs a token", async () => {
    const { request } = setup();
    expect((await request("/pair")).status).toBe(200);
    expect((await request("/pair", { method: "DELETE" })).status).toBe(401);
  });
});

describe("bearer auth", () => {
  it("rejects a missing token", async () => {
    const { request } = setup();
    const res = await request("/status");
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("unauthorized");
  });

  it("rejects a wrong token and a malformed header", async () => {
    const { request, pairing } = setup();
    const token = await pairDirectly(pairing);
    for (const authorization of [`Bearer ${token}x`, `Basic ${token}`, token, "Bearer "]) {
      const res = await request("/status", { headers: { authorization } });
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe("unauthorized");
    }
  });

  it("accepts a paired token", async () => {
    const { request, auth } = await authed();
    const res = await request("/status", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SIGNED_IN);
  });

  it("guards unknown routes too", async () => {
    const { request, auth } = await authed();
    expect((await request("/nope")).status).toBe(401);
    const res = await request("/nope", { headers: auth });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not-found");
  });
});

describe("content type", () => {
  it("rejects a text/plain POST with 415", async () => {
    const { request, calls } = setup();
    const res = await request("/pair/start", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ clientName: "x" }),
    });
    expect(res.status).toBe(415);
    expect((await errorOf(res)).code).toBe("bad-request");
    expect(calls.opened).toEqual([]);
  });

  it("rejects a body without a content type", async () => {
    const { request } = setup();
    const res = await request("/pair/start", { method: "POST", body: new Blob(['{"clientName":"x"}']) });
    expect(res.status).toBe(415);
  });

  it("wants multipart on upload and JSON elsewhere", async () => {
    const { request, json, auth } = await authed();
    expect((await json("/library/upload", { files: [] }, { headers: auth })).status).toBe(415);
    const form = new FormData();
    form.append("fileIds", "a");
    expect((await request("/library/install", { method: "POST", headers: auth, body: form })).status).toBe(415);
  });

  it("accepts JSON with a charset and bodyless POSTs", async () => {
    const { request, json, auth } = await authed();
    const withCharset = await json(
      "/library/install",
      { fileIds: ["a"] },
      { headers: { ...auth, "content-type": "application/json; charset=utf-8" } },
    );
    expect(withCharset.status).toBe(200);
    expect((await request("/library/create", { method: "POST", headers: auth })).status).toBe(200);
  });
});

describe("pairing over HTTP", () => {
  it("runs the whole flow", async () => {
    const { json, request, pairing, calls, clock } = setup();

    const started = await json("/pair/start", { clientName: "Figma desktop" });
    expect(started.status).toBe(200);
    const { expiresAt } = (await started.json()) as { expiresAt: string };
    expect(Date.parse(expiresAt)).toBe(clock.now() + 5 * 60_000);
    expect(calls.opened).toEqual([`http://localhost:${PORT}/pair`]);

    const pending = pairing.pending();
    if (!pending) throw new Error("a code should be pending");
    expect(calls.printed.join("\n")).toContain(pending.code);
    const wrong = pending.code === "000000" ? "000001" : "000000";

    for (let i = 0; i < 4; i++) {
      const res = await json("/pair/complete", { code: wrong, clientName: "Figma desktop" });
      expect(res.status).toBe(401);
    }
    const burned = await json("/pair/complete", { code: wrong, clientName: "Figma desktop" });
    expect(burned.status).toBe(429);
    expect((await errorOf(burned)).code).toBe("rate-limited");
    expect((await json("/pair/complete", { code: pending.code, clientName: "Figma desktop" })).status).toBe(401);

    clock.advance(10_000);
    expect((await json("/pair/start", { clientName: "Figma desktop" })).status).toBe(200);
    const fresh = pairing.pending();
    if (!fresh) throw new Error("a new code should be pending");
    const completed = await json("/pair/complete", { code: fresh.code, clientName: "Figma desktop" });
    expect(completed.status).toBe(200);
    const { token } = (await completed.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    expect((await request("/status", { headers: auth })).status).toBe(200);
    const unpaired = await request("/pair", { method: "DELETE", headers: auth });
    expect(unpaired.status).toBe(200);
    expect(await unpaired.json()).toEqual({ ok: true });
    expect((await request("/status", { headers: auth })).status).toBe(401);
  });

  it("rate-limits /pair/start", async () => {
    const { json, clock, calls } = setup();
    expect((await json("/pair/start", { clientName: "A" })).status).toBe(200);
    const limited = await json("/pair/start", { clientName: "A" });
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe("rate-limited");
    expect(calls.opened).toHaveLength(1);
    clock.advance(10_000);
    expect((await json("/pair/start", { clientName: "A" })).status).toBe(200);
  });
});

describe("errors", () => {
  it("answers a request over the size limit with a 413 the plugin can read", async () => {
    const { request, auth } = await authed();
    const upload = (size: number, headers: Record<string, string> = auth) =>
      request("/library/upload", {
        method: "POST",
        // Only the header is checked, so the body can stay small.
        headers: {
          ...headers,
          origin: "null",
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(size),
        },
        body: "--x--",
      });

    const tooBig = await upload(MAX_REQUEST_BYTES + 1);
    expect(tooBig.status).toBe(413);
    expect(tooBig.headers.get("access-control-allow-origin")).toBe("*");
    expect(await errorOf(tooBig)).toEqual({
      code: "bad-request",
      message: "That is more than 128 MB in one request. Upload fewer files at a time.",
    });
    expect((await upload(MAX_REQUEST_BYTES)).status).not.toBe(413);
    // Without a token nothing is read: the answer is 401 whatever the size.
    expect((await upload(MAX_REQUEST_BYTES + 1, {})).status).toBe(401);
  });

  it("returns validation failures as 400 bad-request", async () => {
    const { json } = setup();
    const res = await json("/pair/start", {});
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("bad-request");
    expect(error.message).toContain("clientName");

    const badCode = await json("/pair/complete", { code: "12345", clientName: "A" });
    expect(badCode.status).toBe(400);
  });

  it("returns malformed JSON as 400 bad-request", async () => {
    const { request } = setup();
    const res = await request("/pair/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("bad-request");
  });

  it("validates authed bodies and query strings", async () => {
    const { json, request, auth } = await authed();
    expect((await json("/library/install", { fileIds: [] }, { headers: auth })).status).toBe(400);
    expect((await request("/library/files?refresh=maybe", { headers: auth })).status).toBe(400);
  });

  it.each(ERROR_CODES.map((code) => [code, ERROR_STATUS[code]] as const))("maps HelperError %s to %d", async (code, status) => {
    const { request, auth } = await authed({
      members: async () => {
        throw new HelperError(code, `message for ${code}`);
      },
    });
    const res = await request("/library/members", { headers: auth });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code, message: `message for ${code}` } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("uses the documented statuses", () => {
    expect(ERROR_STATUS).toEqual({
      "bad-request": 400,
      unauthorized: 401,
      forbidden: 403,
      "not-found": 404,
      conflict: 409,
      "not-configured": 409,
      "not-signed-in": 409,
      "no-library": 409,
      "rate-limited": 429,
      "google-error": 502,
      "install-failed": 500,
      internal: 500,
    });
  });

  it("hides unexpected errors behind a generic 500", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { request, auth } = await authed({
        members: async () => {
          throw new Error("secret detail at /Users/someone/path");
        },
      });
      const res = await request("/library/members", { headers: auth });
      expect(res.status).toBe(500);
      const error = await errorOf(res);
      expect(error.code).toBe("internal");
      expect(error.message).not.toContain("secret");
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe("routes", () => {
  it("uploads every file in a multipart body", async () => {
    const { request, auth, calls } = await authed();
    const form = new FormData();
    form.append("files", new File([new Uint8Array([0, 1, 0, 0, 7])], "One.ttf"));
    form.append("files", new File([new TextEncoder().encode("OTTO")], "Two.otf"));
    const res = await request("/library/upload", { method: "POST", headers: auth, body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { name: string; ok: boolean }[] };
    expect(body.results.map((r) => r.name)).toEqual(["One.ttf", "Two.otf"]);

    expect(calls.uploads).toHaveLength(1);
    const [one, two] = calls.uploads[0] ?? [];
    expect(one?.name).toBe("One.ttf");
    expect(one?.bytes).toEqual(new Uint8Array([0, 1, 0, 0, 7]));
    expect(two?.name).toBe("Two.otf");
    expect(new TextDecoder().decode(two?.bytes)).toBe("OTTO");
  });

  it("uploads a single file", async () => {
    const { request, auth, calls } = await authed();
    const form = new FormData();
    form.append("files", new File([new Uint8Array([1])], "Solo.ttf"));
    const res = await request("/library/upload", { method: "POST", headers: auth, body: form });
    expect(res.status).toBe(200);
    expect(calls.uploads[0]?.map((f) => f.name)).toEqual(["Solo.ttf"]);
  });

  it("rejects an upload without files", async () => {
    const { request, auth } = await authed();
    const form = new FormData();
    form.append("note", "no files here");
    const res = await request("/library/upload", { method: "POST", headers: auth, body: form });
    expect(res.status).toBe(400);
  });

  it("returns the consent URL from /auth/login", async () => {
    const { request, auth } = await authed();
    const res = await request("/auth/login", { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
  });

  it("passes install ids, refresh and the file id through", async () => {
    let refreshSeen: boolean | null = null;
    let removed: string | null = null;
    const { request, json, auth, calls } = await authed({
      files: async ({ refresh }) => {
        refreshSeen = refresh;
        return { files: [], syncedAt: "2026-10-07T12:00:00.000Z" };
      },
      remove: async (fileId) => {
        removed = fileId;
        return "unlinked";
      },
    });
    const installed = await json("/library/install", { fileIds: ["a", "b"] }, { headers: auth });
    expect(await installed.json()).toEqual({
      results: [
        { fileId: "a", ok: true, error: null },
        { fileId: "b", ok: true, error: null },
      ],
      reloadRequired: true,
    });
    expect(calls.installs).toEqual([["a", "b"]]);

    await request("/library/files?refresh=true", { headers: auth });
    expect(refreshSeen as boolean | null).toBe(true);

    const res = await request("/library/files/abc123", { method: "DELETE", headers: auth });
    expect(await res.json()).toEqual({ removed: "unlinked" });
    expect(removed as string | null).toBe("abc123");
  });
});
