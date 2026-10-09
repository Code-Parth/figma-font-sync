import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSecretStoreWith, type SecretsBackend } from "../../src/config/secrets";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "font-sync-secrets-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One OS store; `failing` makes the named methods throw, like a keyring that answers reads but rejects writes. */
function memoryBackend(values = new Map<string, string>()) {
  const calls: string[] = [];
  const failing = new Set<"get" | "set" | "delete">();
  const check = (method: "get" | "set" | "delete") => {
    if (failing.has(method)) throw new Error(`${method} rejected`);
  };
  const backend: SecretsBackend = {
    async get({ service, name }) {
      calls.push(`get ${service}/${name}`);
      check("get");
      return values.get(`${service}/${name}`) ?? null;
    },
    async set({ service, name, value }) {
      calls.push(`set ${service}/${name}`);
      check("set");
      values.set(`${service}/${name}`, value);
    },
    async delete({ service, name }) {
      calls.push(`delete ${service}/${name}`);
      check("delete");
      return values.delete(`${service}/${name}`);
    },
  };
  return { backend, values, calls, failing };
}

function brokenBackend() {
  const fail = async (): Promise<never> => {
    throw new Error("no secret service");
  };
  const backend: SecretsBackend = { get: fail, set: fail, delete: fail };
  return { backend };
}

describe("createSecretStoreWith", () => {
  it("uses the OS backend under service font-sync", async () => {
    const { backend, values, calls } = memoryBackend();
    const store = createSecretStoreWith(backend, dir);
    await store.set("google-refresh-token", "r1");
    expect(values.get("font-sync/google-refresh-token")).toBe("r1");
    expect(await store.get("google-refresh-token")).toBe("r1");
    await store.delete("google-refresh-token");
    expect(await store.get("google-refresh-token")).toBeNull();
    expect(calls[0]).toBe("set font-sync/google-refresh-token");
    expect(await Bun.file(path.join(dir, "credentials.json")).exists()).toBe(false);
  });

  it("falls back to credentials.json when the backend throws", async () => {
    const broken = brokenBackend();
    const store = createSecretStoreWith(broken.backend, dir);
    expect(await store.get("token")).toBeNull();
    await store.set("token", "t1");
    await store.set("other", "o1");
    expect(await store.get("token")).toBe("t1");

    const file = path.join(dir, "credentials.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ token: "t1", other: "o1" });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    await store.delete("token");
    expect(await store.get("token")).toBeNull();
    expect(await store.get("other")).toBe("o1");
  });

  it("reads a value another process could only write to the file", async () => {
    const keyring = new Map<string, string>();
    const writer = memoryBackend(keyring);
    writer.failing.add("set");
    await createSecretStoreWith(writer.backend, dir).set("token", "t1");
    expect(keyring.size).toBe(0);

    // A later process whose OS store answers reads without error, with nothing stored.
    const reader = memoryBackend(keyring);
    expect(await createSecretStoreWith(reader.backend, dir).get("token")).toBe("t1");
  });

  it("deletes from the OS store and the file", async () => {
    const keyring = new Map([["font-sync/token", "old"]]);
    const writer = memoryBackend(keyring);
    writer.failing.add("set");
    await createSecretStoreWith(writer.backend, dir).set("token", "t1");

    const store = createSecretStoreWith(memoryBackend(keyring).backend, dir);
    await store.delete("token");
    expect(keyring.size).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, "credentials.json"), "utf8"))).toEqual({});
    expect(await store.get("token")).toBeNull();
  });

  it("drops the file copy once the OS store accepts a write", async () => {
    const keyring = new Map<string, string>();
    const writer = memoryBackend(keyring);
    writer.failing.add("set");
    await createSecretStoreWith(writer.backend, dir).set("token", "t1");

    const store = createSecretStoreWith(memoryBackend(keyring).backend, dir);
    await store.set("token", "t2");
    expect(keyring.get("font-sync/token")).toBe("t2");
    expect(await store.get("token")).toBe("t2");
    expect(JSON.parse(await readFile(path.join(dir, "credentials.json"), "utf8"))).toEqual({});
  });

  it("goes back to the OS store after a failure, so a locked keychain does not hide its item", async () => {
    const keychain = memoryBackend(new Map([["font-sync/token", "kept"]]));
    const store = createSecretStoreWith(keychain.backend, dir);
    keychain.failing.add("get");
    expect(await store.get("token")).toBeNull();
    keychain.failing.clear();
    expect(await store.get("token")).toBe("kept");
    await store.delete("token");
    expect(keychain.values.size).toBe(0);
  });
});
