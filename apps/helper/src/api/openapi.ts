import { OpenAPIHono } from "@hono/zod-openapi";
import * as routes from "./routes";

export const PORT = Number(process.env.FONT_SYNC_PORT ?? 47321);

/** Registers every route's schema so the spec does not depend on handler wiring. */
export function buildOpenAPIDocument(version: string) {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", { type: "http", scheme: "bearer" });
  for (const route of Object.values(routes)) app.openAPIRegistry.registerPath(route);
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "Font Sync helper", version },
    servers: [{ url: `http://localhost:${PORT}` }],
  });
}
