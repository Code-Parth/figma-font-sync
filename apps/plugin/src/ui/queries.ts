import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import type { FontKey } from "../shared/messages";
import { listLibraryFilesQueryKey } from "./api/@tanstack/react-query.gen";
import { installFonts, listLibraryFiles, resolveFonts, uninstallFonts } from "./api/sdk.gen";
import type { FileResult, LibraryFiles, ResolvedFont } from "./api/types.gen";
import { asApiError } from "./errors";
import { describeInstall, type InstallAction } from "./library";
import type { ReloadReason } from "./state";
import { chunk, resolveInBatches } from "./status";
import { useAnnounce } from "./ui";

/** POST /fonts/resolve is not a generated query, so its cache key lives here. */
export const RESOLVE_QUERY = "font-resolve";

export function resolveQueryKey(libraryId: string, scannedAt: number) {
  return [RESOLVE_QUERY, libraryId, scannedAt] as const;
}

/**
 * Resolves fonts against a fresh listing of the library folder. The helper keeps its listing for as long
 * as it runs, days when it starts at login, so without the refresh a font a teammate added since shows as
 * "Not in library". The Library tab gets the new listing too.
 */
export async function resolveAgainstFreshListing(
  queryClient: QueryClient,
  fonts: readonly FontKey[],
): Promise<ResolvedFont[]> {
  const { data } = await listLibraryFiles({ query: { refresh: "true" }, throwOnError: true });
  queryClient.setQueryData(listLibraryFilesQueryKey(), data);
  return resolveInBatches(
    fonts,
    async (batch) => (await resolveFonts({ body: { fonts: batch }, throwOnError: true })).data.fonts,
  );
}

/** After the library or this machine's fonts change, both the file list and resolve results are stale. */
export function invalidateLibraryData(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: listLibraryFilesQueryKey() });
  void queryClient.invalidateQueries({ queryKey: [RESOLVE_QUERY] });
}

/** Names a library file from the cached list, for messages that only carry its id. */
export function libraryFileName(queryClient: QueryClient, fileId: string): string | undefined {
  return queryClient.getQueryData<LibraryFiles>(listLibraryFilesQueryKey())?.files.find((file) => file.id === fileId)?.name;
}

/** The helper accepts at most 500 file ids per install or uninstall request. */
const FILE_BATCH = 500;

export type InstallOutcome = { results: FileResult[]; reloadRequired: boolean };

export function useInstallFiles(
  action: InstallAction,
  onReload: (reason: ReloadReason) => void,
  onDone?: (outcome: InstallOutcome) => void,
) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  return useMutation({
    mutationFn: async (fileIds: string[]): Promise<InstallOutcome> => {
      const call = action === "install" ? installFonts : uninstallFonts;
      const outcome: InstallOutcome = { results: [], reloadRequired: false };
      for (const batch of chunk(fileIds, FILE_BATCH)) {
        const { data } = await call({ body: { fileIds: batch }, throwOnError: true });
        outcome.results.push(...data.results);
        outcome.reloadRequired ||= data.reloadRequired;
      }
      return outcome;
    },
    onSuccess: (outcome) => {
      announce(describeInstall(action, outcome.results));
      if (outcome.reloadRequired) onReload(action === "install" ? "installed" : "uninstalled");
      invalidateLibraryData(queryClient);
      onDone?.(outcome);
    },
    onError: (error) => announce(asApiError(error).message),
  });
}

/** The error a failed install left for one file, if the last attempt included it. */
export function fileError(outcome: InstallOutcome | undefined, fileId: string): string | null {
  const result = outcome?.results.find((candidate) => candidate.fileId === fileId);
  if (result === undefined || result.ok) return null;
  return result.error ?? "Failed.";
}
