/**
 * The Google client baked into a compiled binary. scripts/build.ts `define`s these two expressions as
 * string literals only when they are set at build time; otherwise they read the runtime environment.
 * Callers prefer their own runtime env and fall back to these.
 */
export const BUILT_IN_GOOGLE_CLIENT: { clientId: string | undefined; clientSecret: string | undefined } = {
  clientId: process.env.FONT_SYNC_GOOGLE_CLIENT_ID,
  clientSecret: process.env.FONT_SYNC_GOOGLE_CLIENT_SECRET,
};
