import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorCode } from "../errors";
import type { Pairing } from "./pairing";

export type AppEnv = { Variables: { clientId: string } };

/** Which requests skip a middleware, by method and path. HEAD is reported as GET. */
export type RequestMatcher = (method: string, path: string) => boolean;

export function errorJson(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function methodOf(c: Context): string {
  return c.req.method === "HEAD" ? "GET" : c.req.method;
}

/**
 * DNS rebinding defence: a page on attacker.example that rebinds its name to 127.0.0.1 still sends
 * `Host: attacker.example`, so only the loopback names this helper is reached by are accepted.
 */
export function hostCheck(port: number): MiddlewareHandler {
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  return async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    if (!host || !allowed.has(host)) {
      return errorJson(c, 421, "bad-request", `Use http://localhost:${port} to reach the Font Sync helper.`);
    }
    await next();
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
};

/**
 * Plugin iframes send `Origin: null`, and Figma may move them to a real origin later, so Origin is
 * not checked: the bearer token is the gate. `skip` requests get no CORS headers at all.
 */
export function cors(skip: RequestMatcher): MiddlewareHandler {
  return async (c, next) => {
    if (skip(methodOf(c), c.req.path)) {
      await next();
      return;
    }
    const headers: Record<string, string> = { ...CORS_HEADERS };
    // Older Chromium and Electron builds still send the Private Network Access preflight.
    if (c.req.header("access-control-request-private-network") === "true") {
      headers["Access-Control-Allow-Private-Network"] = "true";
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204, headers);
    await next();
    // Set after the handler so error responses are readable by the plugin too.
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  };
}

export function requireToken(pairing: Pick<Pairing, "verify">, isPublic: RequestMatcher): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isPublic(methodOf(c), c.req.path)) {
      await next();
      return;
    }
    const match = /^Bearer ([^\s]+)$/i.exec(c.req.header("authorization") ?? "");
    const verified = match?.[1] ? await pairing.verify(match[1]) : null;
    if (!verified) return errorJson(c, 401, "unauthorized", "Pair the plugin with this helper again.");
    c.set("clientId", verified.clientId);
    await next();
  };
}

const JSON_TYPE = "application/json";
const MULTIPART_TYPE = "multipart/form-data";

/**
 * A request body must be JSON (multipart for `multipartPaths`). JSON is not a CORS "simple" content
 * type, so a cross-site page cannot reach /pair/start or /pair/complete without a preflight. Multipart
 * is simple, which is why it is limited to the upload route: that route needs the Authorization header,
 * and that header forces a preflight on its own.
 */
export function requireJsonBody(multipartPaths: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || !hasBody(c)) {
      await next();
      return;
    }
    const expected = multipartPaths.includes(c.req.path) ? MULTIPART_TYPE : JSON_TYPE;
    const essence = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (essence !== expected) return errorJson(c, 415, "bad-request", `Content-Type must be ${expected}.`);
    await next();
  };
}

function hasBody(c: Context): boolean {
  const length = c.req.header("content-length");
  if (length !== undefined) return Number(length) !== 0;
  return c.req.header("transfer-encoding") !== undefined || c.req.raw.body !== null;
}
