import { Pairing } from "../../src/api/pairing";
import type { Config, Store } from "../../src/config/store";
import type { Helper, Status } from "../../src/helper";

export const PORT = 47321;
export const HOST = `localhost:${PORT}`;

export class MemoryStore<T> implements Store<T> {
  writes = 0;
  constructor(private value: T) {}

  async read(): Promise<T> {
    return structuredClone(this.value);
  }

  async write(value: T): Promise<void> {
    this.writes += 1;
    this.value = structuredClone(value);
  }

  async update(fn: (draft: T) => T | void): Promise<T> {
    const draft = structuredClone(this.value);
    await this.write(fn(draft) ?? draft);
    return structuredClone(this.value);
  }
}

export function emptyConfig(): Config {
  return { libraryFolderId: null, pairedClients: [] };
}

/** A clock tests move by hand. */
export function manualClock(start = Date.UTC(2026, 9, 7, 12, 0, 0)) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

export const SIGNED_IN: Status = {
  version: "0.0.0-test",
  platform: "darwin",
  auth: "signed-in",
  account: { email: "ada@example.com", name: "Ada" },
  library: {
    id: "folder123456",
    name: "font-sync-figma-plugin",
    webViewLink: "https://drive.google.com/drive/folders/folder123456",
    owner: "owner@example.com",
    role: "editor",
    canUpload: true,
  },
  libraryError: null,
};

type Calls = {
  printed: string[];
  opened: string[];
  uploads: { name: string; bytes: Uint8Array }[][];
  installs: string[][];
};

/** A Helper with a real Pairing over memory and no Google, disk or OS access. Override any method. */
export function fakeHelper(overrides: Partial<Helper> = {}, clock = manualClock()) {
  const config = new MemoryStore(emptyConfig());
  const pairing = new Pairing(config, clock.now);
  const calls: Calls = { printed: [], opened: [], uploads: [], installs: [] };
  const helper: Helper = {
    version: "0.0.0-test",
    platform: "darwin",
    pairing,
    openBrowser: async (url) => {
      calls.opened.push(url);
    },
    print: (line) => {
      calls.printed.push(line);
    },
    status: async () => SIGNED_IN,
    login: async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", done: Promise.resolve() }),
    logout: async () => ({ ...SIGNED_IN, auth: "signed-out", account: null, library: null }),
    candidates: async () => ({ folders: [], incomplete: false }),
    selectLibrary: async () => SIGNED_IN,
    createLibrary: async () => SIGNED_IN,
    files: async () => ({ files: [], syncedAt: new Date(clock.now()).toISOString() }),
    resolve: async () => [],
    install: async (fileIds) => {
      calls.installs.push(fileIds);
      return { results: fileIds.map((fileId) => ({ fileId, ok: true, error: null })), reloadRequired: true };
    },
    uninstall: async (fileIds) => ({
      results: fileIds.map((fileId) => ({ fileId, ok: true, error: null })),
      reloadRequired: true,
    }),
    upload: async (files) => {
      calls.uploads.push(files);
      return files.map((f) => ({ name: f.name, ok: true, fileId: `id-${f.name}`, duplicateOf: null, error: null, faces: [] }));
    },
    publishLocal: async () => [],
    remove: async () => "trashed",
    members: async () => [],
    ...overrides,
  };
  return { helper, pairing, config, clock, calls };
}

/** Pairs through the real Pairing (not HTTP) and returns a working token. */
export async function pairDirectly(pairing: Pairing, clientName = "Test plugin"): Promise<string> {
  const { code } = pairing.start(clientName);
  return (await pairing.complete(code, clientName)).token;
}
