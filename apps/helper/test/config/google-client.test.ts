import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGoogleClient, saveGoogleClient, validateClientId } from "../../src/config/google-client";
import { type Config, openConfig } from "../../src/config/store";
import { emptyConfig, MemoryStore } from "../api/support";

const ID = "123456789012-abcdef0123456789.apps.googleusercontent.com";
const NO_BUILT_IN = { clientId: undefined, clientSecret: undefined };

describe("resolveGoogleClient", () => {
  const stored: Pick<Config, "googleClient"> = { googleClient: { clientId: "config-id", clientSecret: "config-secret" } };

  it("prefers the environment as a pair", () => {
    const env = { FONT_SYNC_GOOGLE_CLIENT_ID: "env-id", FONT_SYNC_GOOGLE_CLIENT_SECRET: "env-secret" };
    expect(resolveGoogleClient(env, stored, NO_BUILT_IN)).toEqual({
      client: { clientId: "env-id", clientSecret: "env-secret" },
      source: "env",
    });
    expect(resolveGoogleClient({ FONT_SYNC_GOOGLE_CLIENT_ID: "env-id" }, stored, NO_BUILT_IN)).toEqual({
      client: { clientId: "env-id", clientSecret: null },
      source: "env",
    });
  });

  it("ignores an environment secret without an id", () => {
    const env = { FONT_SYNC_GOOGLE_CLIENT_SECRET: "env-secret" };
    expect(resolveGoogleClient(env, stored, NO_BUILT_IN)).toEqual({
      client: { clientId: "config-id", clientSecret: "config-secret" },
      source: "config",
    });
  });

  it("falls back to config.json, then to the built-in client", () => {
    const builtIn = { clientId: "built-in-id", clientSecret: "" };
    expect(resolveGoogleClient({}, { googleClient: { clientId: "config-id", clientSecret: null } }, builtIn)).toEqual({
      client: { clientId: "config-id", clientSecret: null },
      source: "config",
    });
    expect(resolveGoogleClient({}, { googleClient: null }, builtIn)).toEqual({
      client: { clientId: "built-in-id", clientSecret: null },
      source: "built-in",
    });
    expect(resolveGoogleClient({}, {}, builtIn)?.source).toBe("built-in");
  });

  it("returns null when nothing names a client", () => {
    expect(resolveGoogleClient({}, emptyConfig(), NO_BUILT_IN)).toBeNull();
    expect(resolveGoogleClient({ FONT_SYNC_GOOGLE_CLIENT_ID: "" }, { googleClient: null }, NO_BUILT_IN)).toBeNull();
  });

  it("skips a hand-edited googleClient of the wrong shape", () => {
    const broken = [{ clientId: 42 }, { clientId: "" }, "client-id", []] as unknown as Config["googleClient"][];
    for (const googleClient of broken) {
      expect(resolveGoogleClient({}, { googleClient }, NO_BUILT_IN)).toBeNull();
    }
    const oddSecret = { clientId: "config-id", clientSecret: 7 } as unknown as Config["googleClient"];
    expect(resolveGoogleClient({}, { googleClient: oddSecret }, NO_BUILT_IN)?.client).toEqual({
      clientId: "config-id",
      clientSecret: null,
    });
  });
});

describe("validateClientId", () => {
  it("accepts a Desktop-app client id, with surrounding space and in any case", () => {
    expect(validateClientId(ID)).toBeNull();
    expect(validateClientId(`  ${ID}\n`)).toBeNull();
    expect(validateClientId(ID.toUpperCase())).toBeNull();
  });

  it("says what a client id looks like and where to find it", () => {
    for (const value of ["", "   ", "my-project", "123456789012", `${ID}.evil.example`, "abc-def.apps.googleusercontent.com"]) {
      const message = validateClientId(value);
      expect(message).not.toBeNull();
      expect(message).toContain("Desktop app");
    }
    expect(validateClientId("123456789012")).toContain(".apps.googleusercontent.com");
  });

  it("recognizes a pasted client secret without repeating it", () => {
    const message = validateClientId("GOCSPX-abcdefghijklmnopqrstuvwxyz12");
    expect(message).toContain("client secret");
    expect(message).not.toContain("GOCSPX-abcdefghijklmnopqrstuvwxyz12");
  });
});

describe("saveGoogleClient", () => {
  it("trims both values, stores an empty secret as null and keeps the rest of config", async () => {
    const config = new MemoryStore<Config>({ ...emptyConfig(), libraryFolderId: "folder1" });
    await saveGoogleClient(config, { clientId: `  ${ID} `, clientSecret: " secret\n" });
    expect(await config.read()).toEqual({
      libraryFolderId: "folder1",
      pairedClients: [],
      googleClient: { clientId: ID, clientSecret: "secret" },
    });
    await saveGoogleClient(config, { clientId: ID, clientSecret: "  " });
    expect((await config.read()).googleClient).toEqual({ clientId: ID, clientSecret: null });
    await saveGoogleClient(config, { clientId: ID, clientSecret: null });
    expect((await config.read()).googleClient).toEqual({ clientId: ID, clientSecret: null });
  });
});

describe("openConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "font-sync-google-client-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads defaults with no Google client from a missing file", async () => {
    const config = openConfig(dir);
    expect(config.path).toBe(path.join(dir, "config.json"));
    expect(await config.read()).toEqual({ libraryFolderId: null, pairedClients: [], googleClient: null });
  });

  it("stores the client in config.json, owner-only, where resolveGoogleClient finds it", async () => {
    await saveGoogleClient(openConfig(dir), { clientId: ID, clientSecret: "secret" });
    const file = path.join(dir, "config.json");
    expect(JSON.parse(await readFile(file, "utf8")).googleClient).toEqual({ clientId: ID, clientSecret: "secret" });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(resolveGoogleClient({}, await openConfig(dir).read(), NO_BUILT_IN)?.source).toBe("config");
  });
});
