import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getStatusQueryKey, listLibraryCandidatesOptions } from "../api/@tanstack/react-query.gen";
import { createLibrary, selectLibrary } from "../api/sdk.gen";
import type { Library, Status } from "../api/types.gen";
import { formatDate } from "../format";
import { ErrorText, Screen, useAnnounce } from "../ui";

const FOLDER_NAME = "font-sync-figma-plugin";

/** `current` is the selected library when the user came here to change it, otherwise null. */
export function LibraryPicker({ current, onDone }: { current: Library; onDone: () => void }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const candidates = useQuery(listLibraryCandidatesOptions());

  const chosen = async (status: Status) => {
    queryClient.setQueryData(getStatusQueryKey(), status);
    announce("Library selected.");
    onDone();
    // Every cached list and resolve result belongs to the previous library.
    await queryClient.invalidateQueries();
  };

  const select = useMutation({
    mutationFn: async (folderId: string) => (await selectLibrary({ body: { folderId }, throwOnError: true })).data,
    onSuccess: chosen,
  });
  const create = useMutation({
    mutationFn: async () => (await createLibrary({ throwOnError: true })).data,
    onSuccess: chosen,
  });

  // One shared folder is the common case; choosing it is a formality, so do it for the user.
  // Not when they came here to change libraries: that would undo their request. Not after a partial
  // search either: the one folder found may not be the only one.
  const autoSelected = useRef(false);
  const folders = candidates.data?.incomplete ? undefined : candidates.data?.folders;
  const { mutate: selectFolder } = select;
  useEffect(() => {
    const only = folders?.length === 1 ? folders[0] : undefined;
    if (current !== null || autoSelected.current || only === undefined) return;
    autoSelected.current = true;
    selectFolder(only.id);
  }, [current, folders, selectFolder]);

  const checkAgain = (
    <button
      type="button"
      className="button secondary"
      onClick={() => void candidates.refetch()}
      disabled={candidates.isFetching}
    >
      {candidates.isFetching ? "Checking..." : "Check again"}
    </button>
  );

  const busy = select.isPending || create.isPending;

  return (
    <Screen title={current === null ? "Choose your font library" : "Change library"}>
      {candidates.isPending ? (
        <p className="text-secondary" aria-busy="true">
          Looking for {FOLDER_NAME} folders in your Google Drive...
        </p>
      ) : candidates.isError ? (
        <>
          <ErrorText error={candidates.error} />
          <div className="actions">
            <button type="button" className="button secondary" onClick={() => void candidates.refetch()}>
              Try again
            </button>
          </div>
        </>
      ) : candidates.data.folders.length === 0 && candidates.data.incomplete ? (
        <>
          <p>
            Google Drive answered with a partial search, so a <span className="mono">{FOLDER_NAME}</span> folder shared
            with you may be missing. Check again in a minute.
          </p>
          <div className="actions">{checkAgain}</div>
        </>
      ) : candidates.data.folders.length === 0 ? (
        <>
          <p>
            No folder named <span className="mono">{FOLDER_NAME}</span> is shared with your Google account. If your team
            already has one, ask its owner to share it with you, then check again.
          </p>
          <p>
            Or create the library. Font Sync creates a folder named <span className="mono">{FOLDER_NAME}</span> in your
            Drive and you own it. Share it with your team in Google Drive: editors can add fonts, viewers can install
            them.
          </p>
          <div className="actions">
            <button type="button" className="button primary" onClick={() => create.mutate()} disabled={busy}>
              {create.isPending ? "Creating..." : "Create library"}
            </button>
            {checkAgain}
          </div>
        </>
      ) : (
        <>
          <p>
            {candidates.data.folders.length === 1
              ? `One ${FOLDER_NAME} folder is shared with you.`
              : `Several ${FOLDER_NAME} folders are shared with you. Pick the one your team uses.`}
            {candidates.data.incomplete ? " Google Drive answered with a partial search, so others may be missing." : null}
          </p>
          <ul className="choice-list">
            {candidates.data.folders.map((folder) => {
              const isCurrent = current?.id === folder.id;
              return (
                <li key={folder.id} className="choice">
                  <div className="choice-text">
                    <span className="choice-title">{folder.owner ? `Owned by ${folder.owner}` : folder.name}</span>
                    <span className="text-secondary">Modified {formatDate(folder.modifiedTime)}</span>
                  </div>
                  {isCurrent ? (
                    <span className="badge">Current</span>
                  ) : (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => select.mutate(folder.id)}
                      disabled={busy}
                      aria-label={`Use the library ${folder.owner ? `owned by ${folder.owner}` : folder.name}`}
                    >
                      {select.isPending && select.variables === folder.id ? "Selecting..." : "Use"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {candidates.data.incomplete ? <div className="actions">{checkAgain}</div> : null}
        </>
      )}
      {select.isError ? <ErrorText error={select.error} /> : null}
      {create.isError ? <ErrorText error={create.error} /> : null}
      {current !== null ? (
        <div className="actions">
          <button type="button" className="button secondary" onClick={onDone} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : null}
    </Screen>
  );
}
