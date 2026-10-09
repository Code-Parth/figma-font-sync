import { BUILT_IN_GOOGLE_CLIENT } from "../build-defaults";
import type { GoogleClientConfig } from "../google/oauth";
import type { Config, Store } from "./store";

export type GoogleClientSource = "env" | "config" | "built-in";

/**
 * The client the helper signs in with: FONT_SYNC_GOOGLE_CLIENT_ID (+ _SECRET) from the environment as a
 * pair, else config.json's googleClient, else the one a private build baked in (build-defaults.ts).
 */
export function resolveGoogleClient(
  env: Record<string, string | undefined>,
  config: Pick<Config, "googleClient">,
  builtIn: { clientId: string | undefined; clientSecret: string | undefined } = BUILT_IN_GOOGLE_CLIENT,
): { client: GoogleClientConfig; source: GoogleClientSource } | null {
  if (env.FONT_SYNC_GOOGLE_CLIENT_ID) {
    return {
      client: { clientId: env.FONT_SYNC_GOOGLE_CLIENT_ID, clientSecret: env.FONT_SYNC_GOOGLE_CLIENT_SECRET || null },
      source: "env",
    };
  }
  // config.json is hand-editable, so its shape is checked rather than trusted.
  const stored: unknown = config.googleClient;
  if (isRecord(stored) && typeof stored.clientId === "string" && stored.clientId) {
    const secret = typeof stored.clientSecret === "string" ? stored.clientSecret : null;
    return { client: { clientId: stored.clientId, clientSecret: secret || null }, source: "config" };
  }
  if (builtIn.clientId) {
    return { client: { clientId: builtIn.clientId, clientSecret: builtIn.clientSecret || null }, source: "built-in" };
  }
  return null;
}

const DESKTOP_CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

const WHERE_TO_FIND =
  'Copy it from Google Cloud console > APIs & Services > Credentials, from an OAuth client of type "Desktop app".';

/** Null when it looks like a Desktop-app client id (`<digits>-<chars>.apps.googleusercontent.com`), else why not. */
export function validateClientId(clientId: string): string | null {
  const value = clientId.trim();
  if (DESKTOP_CLIENT_ID.test(value)) return null;
  if (value === "") return `Enter the client ID. ${WHERE_TO_FIND}`;
  // The value itself is never echoed: a pasted secret would end up in the terminal's scrollback.
  if (value.startsWith("GOCSPX-")) {
    return "That is the client secret. The client ID is the other value, ending in .apps.googleusercontent.com.";
  }
  return `A Google client ID looks like 123456789012-abc123def456.apps.googleusercontent.com. ${WHERE_TO_FIND}`;
}

/** Trims both values and stores them in config.json; an empty secret is stored as null. */
export async function saveGoogleClient(config: Store<Config>, client: GoogleClientConfig): Promise<void> {
  const googleClient = { clientId: client.clientId.trim(), clientSecret: client.clientSecret?.trim() || null };
  await config.update((draft) => {
    draft.googleClient = googleClient;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
