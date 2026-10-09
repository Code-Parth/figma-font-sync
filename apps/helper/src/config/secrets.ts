import path from "node:path";
import { JsonFile } from "./store";

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The part of Bun.secrets this module uses; tests pass a fake. */
export type SecretsBackend = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

const SERVICE = "font-sync";

/**
 * Bun.secrets (macOS Keychain, Windows Credential Manager, libsecret) under service "font-sync".
 * A write the OS store rejects goes to `${fallbackDir}/credentials.json` with mode 0600 instead,
 * e.g. Linux without a running secret service. Every read and delete checks both, so the choice
 * is made per write, not per process.
 */
export function createSecretStore(fallbackDir: string): SecretStore {
  return createSecretStoreWith(Bun.secrets, fallbackDir);
}

/** `createSecretStore` with the OS backend injected. */
export function createSecretStoreWith(backend: SecretsBackend, fallbackDir: string): SecretStore {
  const file = new JsonFile<Record<string, string>>(path.join(fallbackDir, "credentials.json"), () => ({}), 0o600);
  const id = (name: string) => ({ service: SERVICE, name });

  async function dropFromFile(name: string): Promise<void> {
    // Checked first so a working OS store never creates the file.
    if ((await file.read())[name] === undefined) return;
    await file.update((secrets) => {
      delete secrets[name];
    });
  }

  return {
    async get(name) {
      // The file only holds a value when the last write could not reach the OS store, so it wins.
      const fromFile = (await file.read())[name];
      if (fromFile !== undefined) return fromFile;
      try {
        return await backend.get(id(name));
      } catch {
        return null;
      }
    },
    async set(name, value) {
      try {
        await backend.set({ ...id(name), value });
      } catch {
        await file.update((secrets) => {
          secrets[name] = value;
        });
        return;
      }
      // A copy left by an earlier fallback would otherwise shadow this value.
      await dropFromFile(name);
    },
    async delete(name) {
      // Either store may hold it: another process may have fallen back to the file.
      try {
        await backend.delete(id(name));
      } catch {
        // The file copy still has to go.
      }
      await dropFromFile(name);
    },
  };
}
