import type { Registration } from "./index";
import type { CommandRunner } from "./run";

/** Rebuilds the fontconfig cache for installDir after every change. */
export function linuxRegistration(installDir: string, run: CommandRunner): Registration {
  async function refresh(): Promise<void> {
    // A missing or failing fc-cache only delays visibility: fontconfig rescans changed directories by itself.
    await run(["fc-cache", "-f", installDir]).catch(() => undefined);
  }
  return {
    async register() {
      await refresh();
      return [];
    },
    unregister: async () => {},
    deleted: refresh,
  };
}
