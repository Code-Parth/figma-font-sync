import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "@hono/zod-openapi";
import { Pairing } from "./api/pairing";
import type { StatusSchema } from "./api/schemas";
import { BUILT_IN_GOOGLE_CLIENT } from "./build-defaults";
import { type Platform, resolvePaths } from "./config/paths";
import { createSecretStore, type SecretStore } from "./config/secrets";
import { type Config, type FacesCache, type InstalledState, JsonFile } from "./config/store";
import { scanLocalFonts } from "./fonts/local-scan";
import type { FontKey } from "./fonts/types";
import { DriveClient } from "./google/drive";
import { GoogleAuth, type GoogleClientConfig } from "./google/oauth";
import { createInstaller } from "./install";
import {
  type Folder,
  type InstallResponse,
  Library,
  type LibraryFile,
  type LibraryInfo,
  type Member,
  type ResolvedFont,
  type UploadResult,
} from "./library/library";
import { VERSION } from "./version";

export type Status = z.infer<typeof StatusSchema>;
export type Account = NonNullable<Status["account"]>;

/** What the HTTP API and the CLI need from the running helper. Tests pass a fake. */
export interface Helper {
  readonly version: string;
  readonly platform: Platform;
  readonly pairing: Pairing;
  /** Opens a page in the user's browser. Never throws; does nothing when FONT_SYNC_NO_BROWSER=1. */
  openBrowser(url: string): Promise<void>;
  /** One line for whoever runs the helper (stdout). Control characters are removed. */
  print(line: string): void;
  status(): Promise<Status>;
  /** Opens Google consent. `done` settles once sign-in and the automatic library pick have finished. */
  login(): Promise<{ url: string; done: Promise<void> }>;
  logout(): Promise<Status>;
  candidates(): Promise<{ folders: Folder[]; incomplete: boolean }>;
  selectLibrary(folderId: string): Promise<Status>;
  createLibrary(): Promise<Status>;
  files(opts: { refresh: boolean }): Promise<{ files: LibraryFile[]; syncedAt: string }>;
  resolve(fonts: FontKey[]): Promise<ResolvedFont[]>;
  install(fileIds: string[]): Promise<InstallResponse>;
  uninstall(fileIds: string[]): Promise<InstallResponse>;
  upload(files: { name: string; bytes: Uint8Array }[]): Promise<UploadResult[]>;
  publishLocal(fonts: FontKey[]): Promise<UploadResult[]>;
  remove(fileId: string): Promise<"trashed" | "unlinked">;
  members(): Promise<Member[]>;
}

export type HelperOptions = {
  platform: Platform;
  env: Record<string, string | undefined>;
  home: string;
  openUrl: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  /** Defaults to the OS secret store; tests pass a fake so they never reach the keychain. */
  secrets?: SecretStore;
};

/** Long enough to cover a burst of /fonts/resolve calls during one scan, short enough to notice a manual install. */
const LOCAL_SCAN_TTL_MS = 30_000;

export async function createHelper(opts: HelperOptions): Promise<Helper> {
  const { platform, env } = opts;
  const paths = resolvePaths(platform, env, opts.home);
  await Promise.all(
    [paths.configDir, paths.cacheDir, paths.stateDir].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
  const config = new JsonFile<Config>(join(paths.configDir, "config.json"), () => ({
    libraryFolderId: null,
    pairedClients: [],
  }));
  const installed = new JsonFile<InstalledState>(join(paths.stateDir, "installed.json"), () => ({
    files: {},
    pendingDeletes: [],
  }));
  const facesCache = new JsonFile<FacesCache>(join(paths.cacheDir, "library-faces.json"), () => ({}));

  const openBrowser = async (url: string): Promise<void> => {
    if (env.FONT_SYNC_NO_BROWSER === "1") return;
    try {
      await opts.openUrl(url);
    } catch (err) {
      warn(`${errorMessage(err)}. Open ${url} yourself.`);
    }
  };

  const auth = new GoogleAuth({
    client: googleClient(env),
    secrets: opts.secrets ?? createSecretStore(paths.configDir),
    openUrl: openBrowser,
    fetch: opts.fetch,
  });
  const drive = new DriveClient(
    { accessToken: () => auth.accessToken(), invalidate: (token) => auth.invalidateAccessToken(token) },
    opts.fetch,
  );
  const installer = createInstaller(platform, paths);
  const localFonts = expiringMemo(
    () => scanLocalFonts(paths.fontDirs, join(paths.cacheDir, "local-fonts.json")),
    LOCAL_SCAN_TTL_MS,
  );
  const newLibrary = () => new Library({ drive, installer, config, installed, facesCache, localFonts: localFonts.get });
  // Library caches the account's email and the folder listing; a different Google account needs a fresh one.
  let library = newLibrary();
  const pairing = new Pairing(config, Date.now, () =>
    warn("Pairing is locked after too many wrong codes; restart the helper to pair again. Something may have been guessing codes."),
  );
  // Library writes go through Drive, installed.json and the OS font folder; two at once could
  // install the same file twice or race an uninstall, so they run one after another.
  const serialize = createQueue();
  let account: Account | null = null;
  let lastStatusWarning: string | null = null;

  /**
   * `font-sync login` and `logout` run in their own process and change only the stored token. The plugin
   * does not poll /status while the helper is healthy, so every Drive-backed call checks too.
   */
  async function followStoredToken(): Promise<void> {
    if (await auth.syncStoredToken()) {
      account = null;
      library = newLibrary();
    }
  }

  /** `task` reads `library` only after followStoredToken may have replaced it. */
  async function asStoredAccount<T>(task: () => Promise<T>): Promise<T> {
    await followStoredToken();
    return task();
  }

  async function status(): Promise<Status> {
    let libraryInfo: LibraryInfo | null = null;
    let libraryError: string | null = null;
    await followStoredToken();
    if (auth.state() === "signed-in") {
      try {
        account ??= await drive.about();
        libraryInfo = await library.info();
        lastStatusWarning = null;
      } catch (err) {
        // /status is polled; a Google outage should show up once in the log, not every few seconds.
        const message = errorMessage(err);
        libraryError = message;
        if (message !== lastStatusWarning) warn(`Could not read the library: ${message}`);
        lastStatusWarning = message;
      }
    }
    // Read after the Google calls: a revoked refresh token is only discovered while using it.
    const state = auth.state();
    return {
      version: VERSION,
      platform,
      auth: state,
      account: state === "signed-out" || state === "not-configured" ? null : account,
      library: state === "signed-in" ? libraryInfo : null,
      libraryError: state === "signed-in" ? libraryError : null,
    };
  }

  async function afterLogin(): Promise<void> {
    library = newLibrary();
    try {
      account = await drive.about();
    } catch (err) {
      warn(`Signed in, but could not read the Google account: ${errorMessage(err)}`);
    }
    try {
      await serialize(async () => {
        if ((await config.read()).libraryFolderId) return;
        const {
          folders: [only, ...others],
        } = await library.candidates();
        if (only && others.length === 0) await library.select(only.id);
      });
    } catch (err) {
      warn(`Signed in, but could not pick a library folder: ${errorMessage(err)}`);
    }
  }

  async function retryPendingDeletes(): Promise<void> {
    const { pendingDeletes, files } = await installed.read();
    if (pendingDeletes.length === 0) return;
    // A later install may have reused a pending path (same bytes); that file is in use again.
    const inUse = new Set(Object.values(files).flatMap((record) => record.paths));
    const stale = pendingDeletes.filter((path) => !inUse.has(path));
    const stillPending = new Set(stale.length > 0 ? await installer.retryPendingDeletes(stale) : []);
    const deleted = new Set(pendingDeletes.filter((path) => inUse.has(path) || !stillPending.has(path)));
    await installed.update((draft) => {
      draft.pendingDeletes = draft.pendingDeletes.filter((path) => !deleted.has(path));
    });
  }

  async function changingInstalledFonts<T>(task: () => Promise<T>): Promise<T> {
    return serialize(async () => {
      try {
        return await task();
      } finally {
        localFonts.invalidate();
      }
    });
  }

  await auth.init();
  await serialize(retryPendingDeletes).catch((err) => warn(`Could not delete old font files: ${errorMessage(err)}`));

  return {
    version: VERSION,
    platform,
    pairing,
    openBrowser,
    print: (line) => console.log(line.replace(/\p{Cc}/gu, "")),
    status,
    async login() {
      const { url, done } = await auth.startLogin();
      const finished = done.then(afterLogin);
      // The plugin polls /status instead of waiting on this; only the CLI awaits it.
      finished.catch(() => undefined);
      return { url, done: finished };
    },
    async logout() {
      await auth.logout();
      account = null;
      library = newLibrary();
      return status();
    },
    candidates: () => asStoredAccount(() => library.candidates()),
    async selectLibrary(folderId) {
      await asStoredAccount(() => serialize(() => library.select(folderId)));
      return status();
    },
    async createLibrary() {
      await asStoredAccount(() => serialize(() => library.create()));
      return status();
    },
    files: (filesOpts) => asStoredAccount(() => library.files(filesOpts)),
    resolve: (fonts) => asStoredAccount(() => library.resolve(fonts)),
    install: (fileIds) => asStoredAccount(() => changingInstalledFonts(() => library.install(fileIds))),
    uninstall: (fileIds) => asStoredAccount(() => changingInstalledFonts(() => library.uninstall(fileIds))),
    upload: (files) => asStoredAccount(() => serialize(() => library.upload(files))),
    publishLocal: (fonts) => asStoredAccount(() => serialize(() => library.publishLocal(fonts))),
    remove: (fileId) => asStoredAccount(() => serialize(() => library.remove(fileId))),
    members: () => asStoredAccount(() => library.members()),
  };
}

/** Runtime env wins as a pair; the client baked in at build time is the fallback. */
function googleClient(env: Record<string, string | undefined>): GoogleClientConfig | null {
  if (env.FONT_SYNC_GOOGLE_CLIENT_ID) {
    return { clientId: env.FONT_SYNC_GOOGLE_CLIENT_ID, clientSecret: env.FONT_SYNC_GOOGLE_CLIENT_SECRET || null };
  }
  const { clientId, clientSecret } = BUILT_IN_GOOGLE_CLIENT;
  return clientId ? { clientId, clientSecret: clientSecret || null } : null;
}

/** Runs tasks one at a time in call order; a failed task does not stop the ones queued after it. */
export function createQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Reuses a load for `ttlMs`. A failed load is not remembered. */
export function expiringMemo<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): { get: () => Promise<T>; invalidate: () => void } {
  let entry: { at: number; value: Promise<T> } | null = null;
  return {
    get() {
      if (entry && now() - entry.at < ttlMs) return entry.value;
      const current = { at: now(), value: load() };
      entry = current;
      current.value.catch(() => {
        if (entry === current) entry = null;
      });
      return current.value;
    },
    invalidate() {
      entry = null;
    },
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(line: string): void {
  console.error(`font-sync: ${line}`);
}
