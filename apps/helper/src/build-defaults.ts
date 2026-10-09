/**
 * The Google client baked into a compiled binary. scripts/build.ts `define`s these two expressions as
 * string literals only when they are set at build time; otherwise a binary reads the runtime environment.
 * From source there is nothing baked in, so a developer's shell cannot leak into tests that expect no client.
 * Callers prefer their own runtime env and config.json, and fall back to these.
 */
export const BUILT_IN_GOOGLE_CLIENT: { clientId: string | undefined; clientSecret: string | undefined } =
  Bun.isStandaloneExecutable
    ? { clientId: process.env.FONT_SYNC_GOOGLE_CLIENT_ID, clientSecret: process.env.FONT_SYNC_GOOGLE_CLIENT_SECRET }
    : { clientId: undefined, clientSecret: undefined };
