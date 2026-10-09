import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import type { FontKey, Prefs, ScanScope } from "../../shared/messages";
import { publishLocalFonts } from "../api/sdk.gen";
import { asApiError } from "../errors";
import { formatTime, plural } from "../format";
import { describeUploads, type Outcome } from "../library";
import {
  fileError,
  invalidateLibraryData,
  libraryFileName,
  resolveAgainstFreshListing,
  resolveQueryKey,
  useInstallFiles,
} from "../queries";
import { describeSelection, type PluginState, type ReloadReason } from "../state";
import {
  buildFontGroups,
  countStatuses,
  type FontRow,
  type FontStatus,
  installable,
  STATUS_HINT,
  STATUS_LABEL,
  STATUS_ORDER,
} from "../status";
import { ErrorText, Outcomes, useAnnounce } from "../ui";

type FileTabProps = {
  state: PluginState;
  libraryId: string;
  canUpload: boolean;
  onScan: () => void;
  onPrefs: (prefs: Prefs) => void;
  onSelect: (font: FontKey) => void;
  onReload: (reason: ReloadReason) => void;
};

const SCOPES: readonly (readonly [ScanScope, string])[] = [
  ["page", "This page"],
  ["document", "All pages"],
];

const MISSING: ReadonlySet<FontStatus> = new Set(["install", "reload", "replace", "not-in-library"]);

const sameFont = (a: FontKey, b: FontKey) => a.family === b.family && a.style === b.style;

export function FileTab({ state, libraryId, canUpload, onScan, onPrefs, onSelect, onReload }: FileTabProps) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const { report, scan, prefs } = state;
  const scanning = scan.phase === "scanning";

  const resolve = useQuery({
    queryKey: resolveQueryKey(libraryId, report?.scannedAt ?? 0),
    queryFn: () => resolveAgainstFreshListing(queryClient, report?.fonts ?? []),
    enabled: report !== null && report.fonts.length > 0,
    // A new scan gets a new key and library changes invalidate it, so it never goes stale by age.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const groups = useMemo(
    () => (report === null ? [] : buildFontGroups(report.fonts, resolve.data ?? null, canUpload)),
    [report, resolve.data, canUpload],
  );
  const counts = useMemo(() => countStatuses(groups), [groups]);
  const missing = useMemo(() => installable(groups), [groups]);

  // Figma's font list only changes after a reload, so a re-scan shows the new state of each font.
  const install = useInstallFiles("install", onReload, onScan);

  const [addOutcomes, setAddOutcomes] = useState<Outcome[]>([]);
  const add = useMutation({
    mutationFn: async (fonts: FontKey[]) => (await publishLocalFonts({ body: { fonts }, throwOnError: true })).data,
    onMutate: () => setAddOutcomes([]),
    onSuccess: (data) => {
      const outcomes = describeUploads(data.results, (fileId) => libraryFileName(queryClient, fileId));
      setAddOutcomes(outcomes);
      announce(outcomes.map((outcome) => outcome.text).join(" "));
      invalidateLibraryData(queryClient);
      onScan();
    },
    onError: (error) => announce(asApiError(error).message),
  });

  const busy = install.isPending || add.isPending;
  const installingAll = install.isPending && install.variables.length > 1;

  return (
    <div className="stack">
      <div className="toolbar">
        <fieldset className="segmented">
          <legend className="visually-hidden">Scan scope</legend>
          {SCOPES.map(([value, label]) => (
            <label key={value} className="segment">
              <input
                type="radio"
                name="scope"
                value={value}
                checked={prefs.scope === value}
                onChange={() => onPrefs({ ...prefs, scope: value })}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={prefs.deep}
            onChange={(event) => onPrefs({ ...prefs, deep: event.target.checked })}
          />
          <span>Include hidden layers</span>
        </label>
        <button type="button" className="button primary toolbar-end" onClick={onScan} disabled={scanning}>
          {scanning ? "Scanning..." : "Scan"}
        </button>
      </div>

      {scan.phase === "scanning" ? <ScanProgress done={scan.pagesDone} total={scan.pagesTotal} /> : null}
      {scan.phase === "error" ? <ErrorText>{`Scan failed: ${scan.message}`}</ErrorText> : null}

      {report === null ? (
        scanning ? null : <p className="text-secondary">Scan this file to see the fonts it uses.</p>
      ) : (
        <>
          <p className="text-secondary">
            {report.scope === "page" ? "This page" : "All pages"}
            {report.deep ? " with hidden layers" : ""}: {plural(report.fonts.length, "font")} in{" "}
            {plural(report.nodeCount, "text layer")}, scanned at {formatTime(report.scannedAt)}.
          </p>

          {counts.reload > 0 && state.reload === null ? (
            <p className="banner">
              Some fonts are on this machine, but Figma has not loaded them yet. Reload this tab: right-click the file
              tab &gt; Reload tab, then scan again.
            </p>
          ) : null}

          {resolve.isError ? (
            <div className="actions">
              <ErrorText>{`Couldn't check the library: ${asApiError(resolve.error).message}`}</ErrorText>
              <button type="button" className="button secondary" onClick={() => void resolve.refetch()}>
                Try again
              </button>
            </div>
          ) : null}
          {resolve.isFetching ? <p className="text-secondary">Checking the library...</p> : null}

          {resolve.isSuccess && report.fonts.length > 0 ? (
            <ul className="counts" aria-label="Fonts by status">
              {STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => (
                <li key={status} className="count">
                  <span className={`dot status-${status}`} aria-hidden="true" />
                  <span className="count-value">{counts[status]}</span> {STATUS_LABEL[status]}
                </li>
              ))}
            </ul>
          ) : null}

          {missing.rows.length > 0 ? (
            <div className="actions">
              <button
                type="button"
                className="button primary"
                onClick={() => install.mutate(missing.fileIds)}
                disabled={busy}
              >
                {installingAll ? "Installing..." : `Install all missing (${missing.rows.length})`}
              </button>
            </div>
          ) : null}
          {install.isError ? <ErrorText error={install.error} /> : null}
          {add.isError ? <ErrorText error={add.error} /> : null}
          {addOutcomes.length > 0 ? <Outcomes outcomes={addOutcomes} /> : null}

          {groups.map((group) => (
            <section key={group.family} className="group" aria-label={group.family}>
              <h2 className="group-title">{group.family}</h2>
              <ul className="rows">
                {group.rows.map((row) => {
                  const fileId = row.resolved?.library?.fileId ?? null;
                  return (
                    <FontRowItem
                      key={row.key}
                      row={row}
                      busy={busy}
                      installing={install.isPending && !installingAll && install.variables[0] === fileId}
                      adding={add.isPending && add.variables.some((font) => sameFont(font, row.usage))}
                      error={fileId === null ? null : fileError(install.data, fileId)}
                      onSelect={() => onSelect({ family: row.usage.family, style: row.usage.style })}
                      onInstall={() => fileId !== null && install.mutate([fileId])}
                      onAdd={() => add.mutate([{ family: row.usage.family, style: row.usage.style }])}
                    />
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}

      {/* Pinned to the bottom so the list does not jump when the user clicks a font name. */}
      {state.selection !== null ? (
        <p className="status-bar text-secondary">{describeSelection(state.selection)}</p>
      ) : null}
    </div>
  );
}

function ScanProgress({ done, total }: { done: number; total: number }) {
  const label = total > 0 ? `Scanned ${done} of ${plural(total, "page")}` : "Scanning...";
  return (
    <div className="progress-row">
      {/* Without max and value the bar is indeterminate, which is right until the first progress message. */}
      <progress
        className="progress"
        {...(total > 0 ? { max: total, value: done } : {})}
        aria-label="Scan progress"
      />
      <span className="text-secondary">{label}</span>
    </div>
  );
}

type FontRowItemProps = {
  row: FontRow;
  busy: boolean;
  installing: boolean;
  adding: boolean;
  error: string | null;
  onSelect: () => void;
  onInstall: () => void;
  onAdd: () => void;
};

function FontRowItem({ row, busy, installing, adding, error, onSelect, onInstall, onAdd }: FontRowItemProps) {
  const { usage, status, resolved } = row;
  const library = resolved?.library ?? null;
  const name = `${usage.family} ${usage.style}`;
  const missing = status === null ? !usage.availableInFigma : MISSING.has(status);
  const closeMatch =
    library !== null && library.tier !== "exact" ? `The library has a close match: ${library.face.family} ${library.face.style}` : undefined;

  let trailing: ReactNode;
  if (status === "install") {
    trailing = (
      <button
        type="button"
        className="button secondary small"
        onClick={onInstall}
        disabled={busy}
        title={closeMatch}
        aria-label={`Install ${name}`}
      >
        {installing ? "Installing..." : "Install"}
      </button>
    );
  } else if (status === "add") {
    trailing = (
      <button
        type="button"
        className="button secondary small"
        onClick={onAdd}
        disabled={busy}
        aria-label={`Add ${name} to the library`}
      >
        {adding ? "Adding..." : "Add to library"}
      </button>
    );
  } else {
    const label = status === null ? (usage.availableInFigma ? "Available" : "Missing") : STATUS_LABEL[status];
    const hint =
      status === "replace" && library !== null
        ? `Figma lists it as ${library.face.family} ${library.face.style}. Replace the font in this file with that name.`
        : status === null
          ? undefined
          : STATUS_HINT[status];
    trailing = (
      <span className={`badge status-${status ?? "unknown"}`} title={hint}>
        {label}
      </span>
    );
  }

  return (
    <li className={missing ? "row row-missing" : "row"}>
      <button
        type="button"
        className="row-name link"
        onClick={onSelect}
        title={`Select the layers that use ${name}`}
      >
        {usage.style}
      </button>
      <span className="row-meta text-tertiary">{plural(usage.nodeCount, "layer")}</span>
      <span className="row-action">{trailing}</span>
      {error !== null ? <span className="row-error text-danger">{error}</span> : null}
    </li>
  );
}
