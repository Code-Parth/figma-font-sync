import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";
import { type ErrorCode, HelperError } from "../errors";
import { GoogleApiError } from "../google/drive";
import type { Helper } from "../helper";
import {
  type AppEnv,
  cors,
  errorJson,
  hostCheck,
  type RequestMatcher,
  requireJsonBody,
  requireToken,
} from "./middleware";
import { PAIR_PAGE_HEADERS, renderPairPage } from "./pair-page";
import * as routes from "./routes";

export const ERROR_STATUS: Record<ErrorCode, ContentfulStatusCode> = {
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
};

const PAIR_PAGE_PATH = "/pair";
const MAX_REPORTED_ISSUES = 5;
/** Bun's default request limit. main.ts lifts Bun's own so this one answers, with CORS headers the plugin can read. */
export const MAX_REQUEST_BYTES = 128 * 1024 * 1024;

export function createApp(helper: Helper, opts: { port: number }) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return errorJson(c, 400, "bad-request", describeIssues(result.error));
    },
  });

  const isPairPage: RequestMatcher = (method, path) => method === "GET" && path === PAIR_PAGE_PATH;
  // Exact method + path: a public route with a path parameter would fail closed (need a token).
  const allRoutes: RouteConfig[] = Object.values(routes);
  const publicRoutes = new Set(allRoutes.filter((r) => !r.security).map((r) => `${r.method.toUpperCase()} ${r.path}`));
  const isPublic: RequestMatcher = (method, path) => isPairPage(method, path) || publicRoutes.has(`${method} ${path}`);

  app.use(hostCheck(opts.port));
  app.use(cors(isPairPage));
  app.use(requireToken(helper.pairing, isPublic));
  // After the token check: without a Content-Length, bodyLimit reads the whole body to count it.
  app.use(
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (c) => errorJson(c, 413, "bad-request", "That is more than 128 MB in one request. Upload fewer files at a time."),
    }),
  );
  app.use(requireJsonBody([routes.uploadRoute.path]));

  app.onError((err, c) => {
    if (err instanceof HelperError) return errorJson(c, ERROR_STATUS[err.code], err.code, err.message);
    // Malformed JSON (400) and @hono/zod-openapi's media type gate (415).
    if (err instanceof HTTPException && err.status < 500) {
      return errorJson(c, err.status, codeForStatus(err.status), err.message || "Invalid request.");
    }
    if (err instanceof GoogleApiError) return errorJson(c, 502, "google-error", `Google Drive: ${err.message}`);
    console.error(err);
    return errorJson(c, 500, "internal", "Something went wrong in the Font Sync helper. Its log has the details.");
  });
  app.notFound((c) => errorJson(c, 404, "not-found", "No such endpoint."));

  app.get(PAIR_PAGE_PATH, (c) => c.html(renderPairPage(helper.pairing.pending(), Date.now()), 200, PAIR_PAGE_HEADERS));

  app.openapi(routes.healthRoute, (c) =>
    c.json({ ok: true as const, name: "font-sync" as const, version: helper.version }, 200),
  );

  app.openapi(routes.pairStartRoute, async (c) => {
    const { clientName } = c.req.valid("json");
    const { code, expiresAt } = helper.pairing.start(clientName);
    const pageUrl = `http://localhost:${opts.port}${PAIR_PAGE_PATH}`;
    helper.print(`Pairing code for "${clientName}": ${code} (also shown at ${pageUrl})`);
    await helper.openBrowser(pageUrl);
    return c.json({ expiresAt: expiresAt.toISOString() }, 200);
  });

  app.openapi(routes.pairCompleteRoute, async (c) => {
    const { code, clientName } = c.req.valid("json");
    return c.json(await helper.pairing.complete(code, clientName), 200);
  });

  app.openapi(routes.unpairRoute, async (c) => {
    await helper.pairing.revoke(c.var.clientId);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(routes.statusRoute, async (c) => c.json(await helper.status(), 200));

  app.openapi(routes.loginRoute, async (c) => {
    // GoogleAuth opens the consent page itself; the URL is returned for when no browser opens.
    const { url } = await helper.login();
    return c.json({ url }, 200);
  });

  app.openapi(routes.logoutRoute, async (c) => c.json(await helper.logout(), 200));

  app.openapi(routes.candidatesRoute, async (c) => c.json(await helper.candidates(), 200));

  app.openapi(routes.selectLibraryRoute, async (c) => {
    const { folderId } = c.req.valid("json");
    return c.json(await helper.selectLibrary(folderId), 200);
  });

  app.openapi(routes.createLibraryRoute, async (c) => c.json(await helper.createLibrary(), 200));

  app.openapi(routes.libraryFilesRoute, async (c) => {
    const { refresh } = c.req.valid("query");
    return c.json(await helper.files({ refresh: refresh === "true" }), 200);
  });

  app.openapi(routes.installRoute, async (c) => {
    const { fileIds } = c.req.valid("json");
    return c.json(await helper.install(fileIds), 200);
  });

  app.openapi(routes.uninstallRoute, async (c) => {
    const { fileIds } = c.req.valid("json");
    return c.json(await helper.uninstall(fileIds), 200);
  });

  app.openapi(routes.uploadRoute, async (c) => {
    const { files } = c.req.valid("form");
    const list = Array.isArray(files) ? files : [files];
    if (list.length === 0) throw new HelperError("bad-request", "No files.");
    const inputs = await Promise.all(
      list.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })),
    );
    return c.json({ results: await helper.upload(inputs) }, 200);
  });

  app.openapi(routes.publishLocalRoute, async (c) => {
    const { fonts } = c.req.valid("json");
    return c.json({ results: await helper.publishLocal(fonts) }, 200);
  });

  app.openapi(routes.removeFileRoute, async (c) => {
    const { fileId } = c.req.valid("param");
    return c.json({ removed: await helper.remove(fileId) }, 200);
  });

  app.openapi(routes.membersRoute, async (c) => c.json({ members: await helper.members() }, 200));

  app.openapi(routes.resolveRoute, async (c) => {
    const { fonts } = c.req.valid("json");
    return c.json({ fonts: await helper.resolve(fonts) }, 200);
  });

  return app;
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 429:
      return "rate-limited";
    default:
      return "bad-request";
  }
}

function describeIssues(error: ZodError): string {
  const issues = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length - issues.length;
  return `Invalid request. ${issues.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}
