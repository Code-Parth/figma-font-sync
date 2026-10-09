import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../helper/openapi.json",
  output: "src/ui/api",
  plugins: ["@hey-api/client-fetch", "@tanstack/react-query"],
});
