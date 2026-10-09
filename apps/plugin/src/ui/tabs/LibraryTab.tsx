import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useId, useMemo, useRef, useState } from "react";
import {
  listLibraryFilesOptions,
  listLibraryFilesQueryKey,
  listLibraryMembersOptions,
} from "../api/@tanstack/react-query.gen";
import { listLibraryFiles, removeLibraryFile, uploadFonts } from "../api/sdk.gen";
import type { Library, LibraryFile, UploadResult } from "../api/types.gen";
import { postToMain } from "../bridge";
import { asApiError } from "../errors";
import { formatBytes, formatDate, formatTime, plural } from "../format";
import {
  batchUploads,
  describeUploads,
  FONT_EXTENSIONS,
  groupLibraryFiles,
  memberName,
  memberRoleLabel,
  type Outcome,
  partitionUploads,
} from "../library";
import {
  fileError,
  type InstallOutcome,
  invalidateLibraryData,
  libraryFileName,
  RESOLVE_QUERY,
  useInstallFiles,
} from "../queries";
import type { ReloadReason } from "../state";
import { ErrorText, Outcomes, useAnnounce } from "../ui";

type LibraryTabProps = {
  library: NonNullable<Library>;
  onReload: (reason: ReloadReason) => void;
};

export function LibraryTab({ library, onReload }: LibraryTabProps) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const files = useQuery(listLibraryFilesOptions());
  const refresh = useMutation({
    mutationFn: async () => (await listLibraryFiles({ query: { refresh: "true" }, throwOnError: true })).data,
    onSuccess: (data) => {
      queryClient.setQueryData(listLibraryFilesQueryKey(), data);
      // Resolve results came from the old listing. Not invalidateLibraryData: the list was just set, so refetching it is waste.
      void queryClient.invalidateQueries({ queryKey: [RESOLVE_QUERY] });
      announce(`Library refreshed: ${plural(data.files.length, "file")}.`);
    },
  });

  const groups = useMemo(() => groupLibraryFiles(files.data?.files ?? [], search), [files.data, search]);

  const install = useInstallFiles("install", onReload);
  const uninstall = useInstallFiles("uninstall", onReload);

  const remove = useMutation({
    mutationFn: async (file: LibraryFile) =>
      (await removeLibraryFile({ path: { fileId: file.id }, throwOnError: true })).data,
    onSuccess: (data, file) => {
      setConfirming(null);
      announce(
        data.removed === "trashed"
          ? `Moved ${file.name} to the Google Drive trash.`
          : `Removed ${file.name} from the library folder. Its owner still has the file.`,
      );
      invalidateLibraryData(queryClient);
    },
    onError: (error) => announce(asApiError(error).message),
  });

  const busy = install.isPending || uninstall.isPending || remove.isPending;

  return (
    <div className="stack">
      <div className="toolbar">
        <label className="visually-hidden" htmlFor={searchId}>
          Search the library
        </label>
        <input
          id={searchId}
          className="input search"
          type="search"
          placeholder="Search family, style or file"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className="button secondary"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Refreshing..." : "Refresh"}
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={() => postToMain({ type: "open-external", url: library.webViewLink })}
        >
          Open in Google Drive
        </button>
      </div>
      {refresh.isError ? <ErrorText error={refresh.error} /> : null}

      {library.canUpload ? <Upload /> : null}

      {files.isPending ? (
        <p className="text-secondary" aria-busy="true">
          Loading the library...
        </p>
      ) : files.isError ? (
        <div className="actions">
          <ErrorText error={files.error} />
          <button type="button" className="button secondary" onClick={() => void files.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <p className="text-secondary">
            {plural(files.data.files.length, "file")}, synced at {formatTime(files.data.syncedAt)}.
          </p>
          {install.isError ? <ErrorText error={install.error} /> : null}
          {uninstall.isError ? <ErrorText error={uninstall.error} /> : null}
          {remove.isError ? <ErrorText error={remove.error} /> : null}
          {groups.length === 0 ? (
            <p className="text-secondary">
              {files.data.files.length === 0
                ? library.canUpload
                  ? "The library is empty. Add font files above."
                  : "The library is empty. Someone who can edit the folder needs to add fonts."
                : "No fonts match your search."}
            </p>
          ) : null}
          {groups.map((group) => (
            <section
              key={group.family ?? ""}
              className="group"
              aria-label={group.family ?? "Files that could not be read"}
            >
              <h2 className="group-title">{group.family ?? "Files that could not be read"}</h2>
              <ul className="file-list">
                {group.entries.map(({ file, styles }) => (
                  <FileItem
                    key={file.id}
                    file={file}
                    styles={styles}
                    busy={busy}
                    installing={install.isPending && install.variables.includes(file.id)}
                    uninstalling={uninstall.isPending && uninstall.variables.includes(file.id)}
                    removing={remove.isPending && remove.variables.id === file.id}
                    error={lastError([install.data, uninstall.data], file.id)}
                    confirming={confirming === file.id}
                    onInstall={() => install.mutate([file.id])}
                    onUninstall={() => uninstall.mutate([file.id])}
                    onRemove={() => setConfirming(file.id)}
                    onConfirmRemove={() => remove.mutate(file)}
                    onCancelRemove={() => setConfirming(null)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      <Members />
    </div>
  );
}

function lastError(outcomes: (InstallOutcome | undefined)[], fileId: string): string | null {
  for (const outcome of outcomes) {
    const error = fileError(outcome, fileId);
    if (error !== null) return error;
  }
  return null;
}

type FileItemProps = {
  file: LibraryFile;
  styles: string[];
  busy: boolean;
  installing: boolean;
  uninstalling: boolean;
  removing: boolean;
  error: string | null;
  confirming: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
};

const INSTALL_LABEL: Record<LibraryFile["install"], string> = {
  "not-installed": "Not installed",
  installed: "Installed",
  outdated: "Update available",
  "not-in-library": "No longer in library",
};

function FileItem({
  file,
  styles,
  busy,
  installing,
  uninstalling,
  removing,
  error,
  confirming,
  onInstall,
  onUninstall,
  onRemove,
  onConfirmRemove,
  onCancelRemove,
}: FileItemProps) {
  const location = file.path ? `${file.path}/` : "";

  return (
    <li className="file">
      <div className="file-head">
        <span className="file-name" title={`${location}${file.name}`}>
          {file.name}
        </span>
        <span className={`badge install-${file.install}`}>{INSTALL_LABEL[file.install]}</span>
      </div>
      {styles.length > 0 ? <p className="file-styles">{styles.join(", ")}</p> : null}
      <p className="file-meta text-tertiary">
        {[
          location ? `In ${file.path}` : null,
          formatBytes(file.size),
          file.uploadedBy ? `Added by ${file.uploadedBy}` : null,
          formatDate(file.modifiedTime),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </p>
      {file.parseError !== null ? <p className="text-danger">Couldn't read this file: {file.parseError}</p> : null}
      {error !== null ? <p className="text-danger">{error}</p> : null}
      {confirming ? (
        <div className="confirm" role="group" aria-label={`Remove ${file.name}?`}>
          <span>Remove {file.name} from the library for everyone?</span>
          <div className="actions">
            <button type="button" className="button danger small" onClick={onConfirmRemove} disabled={busy}>
              {removing ? "Removing..." : "Remove"}
            </button>
            {/* The safe choice takes focus, and the Remove button that opened this is gone. */}
            <button
              type="button"
              className="button secondary small"
              onClick={onCancelRemove}
              disabled={removing}
              autoFocus
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          {file.install === "not-installed" && file.faces.length > 0 ? (
            <button type="button" className="button secondary small" onClick={onInstall} disabled={busy}>
              {installing ? "Installing..." : "Install"}
            </button>
          ) : null}
          {file.install === "outdated" ? (
            <button type="button" className="button secondary small" onClick={onInstall} disabled={busy}>
              {installing ? "Updating..." : "Update"}
            </button>
          ) : null}
          {file.install !== "not-installed" ? (
            <button type="button" className="button secondary small" onClick={onUninstall} disabled={busy}>
              {uninstalling ? "Uninstalling..." : "Uninstall"}
            </button>
          ) : null}
          {file.canRemove ? (
            <button type="button" className="button ghost small" onClick={onRemove} disabled={busy}>
              Remove
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}

function Upload() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const results: UploadResult[] = [];
      for (const batch of batchUploads(files)) {
        results.push(...(await uploadFonts({ body: { files: batch }, throwOnError: true })).data.results);
      }
      return { results };
    },
    onSuccess: (data) => {
      const results = describeUploads(data.results, (fileId) => libraryFileName(queryClient, fileId));
      setOutcomes((previous) => [...previous, ...results]);
      const added = data.results.filter((result) => result.ok && result.duplicateOf === null).length;
      announce(`${plural(added, "file")} added to the library.`);
      invalidateLibraryData(queryClient);
    },
    onError: (error) => announce(asApiError(error).message),
  });

  const send = (list: FileList | null) => {
    if (list === null || list.length === 0) return;
    if (upload.isPending) {
      announce("Wait for the current upload to finish.");
      return;
    }
    const { accepted, rejected } = partitionUploads([...list]);
    setOutcomes(rejected.map(({ file, reason }) => ({ tone: "danger", text: `${file.name}: ${reason}` })));
    if (accepted.length > 0) upload.mutate(accepted);
    else announce("No font files to upload.");
  };

  // Without preventDefault on dragenter and dragover the browser refuses the drop.
  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    send(event.dataTransfer.files);
  };

  return (
    <div className="stack-tight">
      <div
        className={dragging ? "dropzone dropzone-active" : "dropzone"}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="text-secondary">
          {upload.isPending ? "Uploading..." : `Drop ${FONT_EXTENSIONS.join(", ")} files here, or`}
        </span>
        <button
          type="button"
          className="button secondary small"
          onClick={() => picker.current?.click()}
          disabled={upload.isPending}
        >
          Choose files
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={FONT_EXTENSIONS.join(",")}
          hidden
          aria-label="Font files to add"
          onChange={(event) => {
            send(event.target.files);
            // Reset so choosing the same file again still fires change.
            event.target.value = "";
          }}
        />
      </div>
      {upload.isError ? <ErrorText error={upload.error} /> : null}
      {outcomes.length > 0 ? <Outcomes outcomes={outcomes} /> : null}
    </div>
  );
}

function Members() {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const members = useQuery({ ...listLibraryMembersOptions(), enabled: open });

  return (
    <section className="members">
      <h2 className="group-title">
        <button
          type="button"
          className="disclosure"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="disclosure-icon" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          Members
        </button>
      </h2>
      <div id={regionId} hidden={!open}>
        {open ? (
          members.isPending ? (
            <p className="text-secondary">Loading members...</p>
          ) : members.isError ? (
            <ErrorText error={members.error} />
          ) : (
            <>
              <ul className="rows">
                {members.data.members.map((member, index) => (
                  <li key={member.email ?? `${member.type}-${index}`} className="row">
                    <span className="row-name">{memberName(member)}</span>
                    <span className="row-action text-secondary">{memberRoleLabel(member.role)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-tertiary">Sharing is managed in Google Drive: use Open in Google Drive, then Share.</p>
            </>
          )
        ) : null}
      </div>
    </section>
  );
}
