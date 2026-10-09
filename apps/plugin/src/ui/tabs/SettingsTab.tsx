import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getStatusQueryKey } from "../api/@tanstack/react-query.gen";
import { logout, unpair } from "../api/sdk.gen";
import type { Library, Status } from "../api/types.gen";
import { postToMain } from "../bridge";
import { asApiError } from "../errors";
import { ROLE_LABEL } from "../library";
import { ErrorText, useAnnounce } from "../ui";

const PLATFORM_LABEL: Record<Status["platform"], string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

type SettingsTabProps = {
  status: Status;
  library: NonNullable<Library>;
  version: string | undefined;
  onChangeLibrary: () => void;
  onUnpaired: () => void;
};

export function SettingsTab({ status, library, version, onChangeLibrary, onUnpaired }: SettingsTabProps) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const signOut = useMutation({
    mutationFn: async () => (await logout({ throwOnError: true })).data,
    onSuccess: (next) => {
      announce("Signed out of Google.");
      queryClient.setQueryData(getStatusQueryKey(), next);
    },
  });

  const forget = useMutation({
    mutationFn: async () => (await unpair({ throwOnError: true })).data,
    onSuccess: onUnpaired,
    onError: (error) => {
      // The helper already forgot this token, which is the outcome the user asked for.
      if (asApiError(error).status === 401) onUnpaired();
    },
  });

  return (
    <div className="stack">
      <section className="settings-section" aria-labelledby="settings-account">
        <h2 id="settings-account" className="group-title">
          Google account
        </h2>
        <p>
          {status.account?.name ? `${status.account.name}, ` : ""}
          {status.account?.email ?? "Unknown account"}
        </p>
        <div className="actions">
          <button type="button" className="button secondary" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            {signOut.isPending ? "Signing out..." : "Sign out"}
          </button>
        </div>
        {signOut.isError ? <ErrorText error={signOut.error} /> : null}
      </section>

      <section className="settings-section" aria-labelledby="settings-library">
        <h2 id="settings-library" className="group-title">
          Library
        </h2>
        <p>
          {library.name}, {ROLE_LABEL[library.role].toLowerCase()} access
          {library.owner ? `, owned by ${library.owner}` : ""}.
        </p>
        <p className="text-secondary">
          {library.canUpload
            ? "You can install fonts and add new ones."
            : "You can install fonts. Ask the owner for editor access to add fonts."}
        </p>
        <div className="actions">
          <button type="button" className="button secondary" onClick={onChangeLibrary}>
            Change library
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => postToMain({ type: "open-external", url: library.webViewLink })}
          >
            Open in Google Drive
          </button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-helper">
        <h2 id="settings-helper" className="group-title">
          Helper
        </h2>
        <p>
          Font Sync helper {version ?? status.version} on {PLATFORM_LABEL[status.platform]}.
        </p>
        {confirmUnpair ? (
          <div className="confirm" role="group" aria-label="Unpair this plugin?">
            <span>Unpair? You'll need a new pairing code to use the plugin again.</span>
            <div className="actions">
              <button type="button" className="button danger" onClick={() => forget.mutate()} disabled={forget.isPending}>
                {forget.isPending ? "Unpairing..." : "Unpair"}
              </button>
              <button type="button" className="button secondary" onClick={() => setConfirmUnpair(false)} autoFocus>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button type="button" className="button secondary" onClick={() => setConfirmUnpair(true)}>
              Unpair
            </button>
          </div>
        )}
        {forget.isError && asApiError(forget.error).status !== 401 ? <ErrorText error={forget.error} /> : null}
      </section>

      <section className="settings-section" aria-labelledby="settings-help">
        <h2 id="settings-help" className="group-title">
          Help
        </h2>
        <ul className="help-list">
          <li>
            Figma usually doesn't see newly installed fonts until the file tab reloads. Right-click the file tab, choose
            Reload tab, then scan again.
          </li>
          <li>
            Windows: fonts are installed for your user only. If Figma still lists a font as missing after a reload,
            install that file for all users by hand.
          </li>
          <li>
            Linux: Figma has no desktop app, so this plugin can't run there. Run{" "}
            <span className="mono">figma-font-sync sync</span> to install the whole library instead.
          </li>
        </ul>
      </section>
    </div>
  );
}
