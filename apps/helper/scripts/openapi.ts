import { buildOpenAPIDocument } from "../src/api/openapi";
import pkg from "../package.json";

const out = new URL("../openapi.json", import.meta.url);
await Bun.write(out, JSON.stringify(buildOpenAPIDocument(pkg.version), null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
