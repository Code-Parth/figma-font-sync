import type { SecretStore } from "../config/secrets";
import { HelperError } from "../errors";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export type GoogleClientConfig = { clientId: string; clientSecret: string | null };

export type AuthState = "not-configured" | "signed-out" | "signing-in" | "signed-in" | "expired";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REFRESH_TOKEN_SECRET = "google-refresh-token";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60 * 1000;
const REVOKE_TIMEOUT_MS = 5000;

type PendingLogin = {
  server: ReturnType<typeof Bun.serve>;
  timer: ReturnType<typeof setTimeout>;
  fail: (error: Error) => void;
};

type TokenResponse = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
  scope: string | null;
};

/**
 * Google OAuth for an installed app: "Desktop app" client, loopback redirect on an ephemeral
 * 127.0.0.1 port, PKCE S256, state check, access_type=offline, prompt=consent.
 * The refresh token lives in the SecretStore under "google-refresh-token".
 */
export class GoogleAuth {
  private refreshToken: string | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private expired = false;
  private pending: PendingLogin | null = null;
  private refreshing: Promise<string> | null = null;
  // Bumped by every sign-in, sign-out and expiry, so a slow keychain read cannot undo one of them.
  private generation = 0;

  constructor(
    private readonly opts: {
      client: GoogleClientConfig | null;
      secrets: SecretStore;
      openUrl: (url: string) => Promise<void>;
      fetch?: typeof fetch;
      /** Milliseconds since the epoch; injectable so tests can expire tokens. */
      now?: () => number;
      loginTimeoutMs?: number;
    },
  ) {}

  /** Loads the stored refresh token. Call once before anything else. */
  async init(): Promise<void> {
    if (!this.opts.client) return;
    this.refreshToken = await this.opts.secrets.get(REFRESH_TOKEN_SECRET);
  }

  /**
   * Adopts the refresh token another process stored or deleted (`font-sync login`/`logout` while `serve` runs).
   * True when it changed. Does nothing while a sign-in is in progress.
   */
  async syncStoredToken(): Promise<boolean> {
    if (!this.opts.client || this.pending) return false;
    const generation = this.generation;
    const stored = await this.opts.secrets.get(REFRESH_TOKEN_SECRET);
    if (generation !== this.generation || this.pending || stored === this.refreshToken) return false;
    // invalid_grant already deleted the stored token; keep showing "expired" rather than "signed-out".
    if (!stored && !this.refreshToken) return false;
    this.generation++;
    this.refreshToken = stored;
    this.access = null;
    this.expired = false;
    return true;
  }

  state(): AuthState {
    if (!this.opts.client) return "not-configured";
    if (this.pending) return "signing-in";
    if (this.refreshToken) return "signed-in";
    return this.expired ? "expired" : "signed-out";
  }

  /**
   * Starts the loopback listener, opens the consent page, and resolves `done` once tokens are stored.
   * A second call while signing in cancels the first. The listener closes after success, failure, or 10 minutes.
   */
  async startLogin(): Promise<{ url: string; done: Promise<void> }> {
    const client = this.requireClient();
    this.pending?.fail(new HelperError("not-signed-in", "Sign-in was restarted"));

    const verifier = randomBase64Url(48);
    const state = randomBase64Url(32);
    const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Callers may never await `done`; an unobserved rejection must not crash the helper.
    done.catch(() => {});

    let redirectUri = "";
    let codeReceived = false;
    let login: PendingLogin | null = null;
    const finish = (error: Error | null) => {
      if (!login || this.pending !== login) return;
      this.pending = null;
      clearTimeout(login.timer);
      void login.server.stop();
      if (error) rejectDone(error);
      else resolveDone();
    };

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== "/callback" || request.method !== "GET") return page(404, "Not found.");
        if (url.searchParams.get("state") !== state || codeReceived || this.pending !== login) {
          return page(400, "This sign-in link is invalid or has already been used. Start sign-in again from Figma.");
        }
        const googleError = url.searchParams.get("error");
        if (googleError) {
          finish(new HelperError("not-signed-in", `Google sign-in did not complete: ${googleError}`));
          return page(200, `Sign-in did not complete (${googleError}). You can close this tab and try again from Figma.`);
        }
        const code = url.searchParams.get("code");
        if (!code) {
          finish(new HelperError("not-signed-in", "Google did not return an authorization code"));
          return page(400, "Google did not return an authorization code. Start sign-in again from Figma.");
        }
        codeReceived = true;
        try {
          await this.completeLogin(client, code, verifier, redirectUri);
          finish(null);
          return page(200, "Font Sync is signed in to Google Drive. You can close this tab and return to Figma.");
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          finish(failure);
          return page(200, `Sign-in failed: ${failure.message}`);
        }
      },
    });
    if (server.port === undefined) {
      void server.stop(true);
      throw new HelperError("internal", "Could not open a local port for Google sign-in");
    }
    redirectUri = `http://127.0.0.1:${server.port}/callback`;

    const timer = setTimeout(
      () => finish(new HelperError("not-signed-in", "Sign-in timed out; start it again from Figma")),
      this.opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
    );
    timer.unref?.();
    login = { server, timer, fail: (error) => finish(error) };
    this.pending = login;

    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const authUrl = `${AUTH_URL}?${params}`;
    // The URL is also returned to the plugin, which shows it as a link when no browser opens.
    await this.opts.openUrl(authUrl).catch(() => {});
    return { url: authUrl, done };
  }

  /** A valid access token, refreshed when within 60 s of expiry. Throws HelperError not-configured / not-signed-in; invalid_grant moves to "expired". */
  async accessToken(): Promise<string> {
    this.requireClient();
    if (this.access && this.access.expiresAt - EXPIRY_MARGIN_MS > this.now()) return this.access.token;
    const refreshToken = this.refreshToken;
    if (!refreshToken) {
      throw new HelperError(
        "not-signed-in",
        this.expired ? "Google sign-in expired; sign in again" : "Sign in with Google first",
      );
    }
    this.refreshing ??= this.refresh(refreshToken).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Forgets `token` after Google rejected it (401), so the next accessToken() refreshes. */
  invalidateAccessToken(token: string): void {
    // Compare first: a concurrent 401 for the old token must not discard one that was just refreshed.
    if (this.access?.token === token) this.access = null;
  }

  /** Revokes the refresh token (best effort) and deletes it. */
  async logout(): Promise<void> {
    const token = this.refreshToken;
    this.generation++;
    this.refreshToken = null;
    this.access = null;
    this.expired = false;
    await this.opts.secrets.delete(REFRESH_TOKEN_SECRET);
    if (!token) return;
    try {
      await this.fetchImpl(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
    } catch {
      // Revocation is a courtesy to the user's Google account; the token is already gone locally.
    }
  }

  private async completeLogin(
    client: GoogleClientConfig,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<void> {
    const tokens = await this.tokenRequest(client, {
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    // Google's consent screen lets the user untick individual scopes; without Drive the helper is useless.
    if (!tokens.scope?.split(" ").includes(DRIVE_SCOPE)) {
      throw new HelperError(
        "not-signed-in",
        "Google Drive access was not granted. Sign in again and allow Font Sync to see and manage your Drive files.",
      );
    }
    if (!tokens.refreshToken) {
      throw new HelperError("google-error", "Google did not return a refresh token; sign in again");
    }
    await this.opts.secrets.set(REFRESH_TOKEN_SECRET, tokens.refreshToken);
    this.generation++;
    this.refreshToken = tokens.refreshToken;
    this.access = { token: tokens.accessToken, expiresAt: this.now() + tokens.expiresIn * 1000 };
    this.expired = false;
  }

  private async refresh(refreshToken: string): Promise<string> {
    const client = this.requireClient();
    try {
      const tokens = await this.tokenRequest(client, { grant_type: "refresh_token", refresh_token: refreshToken });
      // A logout or a new sign-in while this request was in flight owns the state now.
      if (this.refreshToken !== refreshToken) {
        if (this.access) return this.access.token;
        throw new HelperError("not-signed-in", "Sign in with Google first");
      }
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
        await this.opts.secrets.set(REFRESH_TOKEN_SECRET, tokens.refreshToken);
        this.refreshToken = tokens.refreshToken;
      }
      this.access = { token: tokens.accessToken, expiresAt: this.now() + tokens.expiresIn * 1000 };
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof TokenError && error.oauthError === "invalid_grant") {
        if (this.refreshToken === refreshToken) {
          this.generation++;
          this.refreshToken = null;
          this.access = null;
          this.expired = true;
          // `font-sync login` in another process may have stored a newer token; syncStoredToken picks it up.
          if ((await this.opts.secrets.get(REFRESH_TOKEN_SECRET)) === refreshToken) {
            await this.opts.secrets.delete(REFRESH_TOKEN_SECRET);
          }
        }
        throw new HelperError("not-signed-in", "Google sign-in expired; sign in again");
      }
      throw error;
    }
  }

  private async tokenRequest(client: GoogleClientConfig, params: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({ client_id: client.clientId });
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
    for (const [name, value] of Object.entries(params)) body.set(name, value);

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      });
    } catch (error) {
      throw new HelperError("google-error", `Could not reach Google: ${error instanceof Error ? error.message : String(error)}`);
    }
    const json: unknown = await response.json().catch(() => null);
    const data = isRecord(json) ? json : {};
    if (!response.ok) {
      const code = typeof data.error === "string" ? data.error : null;
      const description = typeof data.error_description === "string" ? data.error_description : null;
      throw new TokenError(code, `Google sign-in failed: ${description ?? code ?? `HTTP ${response.status}`}`);
    }
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
      throw new HelperError("google-error", "Google returned an unexpected token response");
    }
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
      scope: typeof data.scope === "string" ? data.scope : null,
    };
  }

  private requireClient(): GoogleClientConfig {
    if (!this.opts.client) {
      throw new HelperError("not-configured", "Google sign-in is not configured for this helper build");
    }
    return this.opts.client;
  }

  private get fetchImpl(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

/** The token endpoint answered with an OAuth error; `oauthError` is its `error` field (e.g. invalid_grant). */
class TokenError extends HelperError {
  constructor(
    readonly oauthError: string | null,
    message: string,
  ) {
    super("google-error", message);
  }
}

function randomBase64Url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(status: number, message: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Font Sync</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style>
</head>
<body><h1>Font Sync</h1><p>${escapeHtml(message)}</p></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}
