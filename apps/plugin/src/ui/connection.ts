import { MutationCache, QueryCache, QueryClient, type QueryKey } from "@tanstack/react-query";
import { getHealthQueryKey, getStatusQueryKey } from "./api/@tanstack/react-query.gen";
import { client } from "./api/client.gen";
import { asApiError, shouldRetry, STATE_CODES, toApiError } from "./errors";

/** Must stay `localhost`: Figma's manifest rejects IP literals and its CSP blocks anything unlisted. */
export const HELPER_URL = "http://localhost:47321";

// Read by the client's auth callback on every request, so a new token applies without remounting.
let pairingToken: string | null = null;

export function setPairingToken(token: string | null): void {
  pairingToken = token;
}

export function configureClient(): void {
  client.setConfig({ baseUrl: HELPER_URL, auth: () => pairingToken ?? undefined });
  client.interceptors.error.use((error, response, _request, options) => {
    // Cancelled queries must keep their AbortError so TanStack Query treats them as cancelled.
    if (error instanceof Error && error.name === "AbortError") return error;
    return toApiError(error, response?.status ?? 0, Boolean(options.security?.length));
  });
}

function queryId(key: QueryKey): unknown {
  const first = key[0];
  return typeof first === "object" && first !== null && "_id" in first ? first._id : undefined;
}

const HEALTH_ID = queryId(getHealthQueryKey());
const STATUS_ID = queryId(getStatusQueryKey());

/**
 * Any call can reveal that the helper stopped, the pairing was revoked or the helper's sign-in
 * state changed. Re-checking health or status lets the gate screens take over, instead of every
 * screen handling those cases itself.
 */
function recheckGate(queryClient: QueryClient, error: unknown, failedId: unknown): void {
  const apiError = asApiError(error);
  if (apiError.unreachable) {
    if (failedId !== HEALTH_ID) void queryClient.invalidateQueries({ queryKey: getHealthQueryKey() });
    return;
  }
  const stale = (apiError.status === 401 && apiError.authed) || (apiError.code !== null && STATE_CODES.has(apiError.code));
  // The status query handles its own 401; re-checking it from its own error would loop.
  if (stale && failedId !== STATUS_ID) void queryClient.invalidateQueries({ queryKey: getStatusQueryKey() });
}

/**
 * Drops every answer given to the previous pairing token. Health is kept: it needs no token, and
 * resetting it would flash the loading screen.
 */
export function resetSession(queryClient: QueryClient): Promise<void> {
  return queryClient.resetQueries({ predicate: (query) => queryId(query.queryKey) !== HEALTH_ID });
}

export function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => recheckGate(queryClient, error, queryId(query.queryKey)) }),
    mutationCache: new MutationCache({ onError: (error) => recheckGate(queryClient, error, undefined) }),
    defaultOptions: {
      queries: { retry: shouldRetry },
      // Mutations stay at TanStack's default of no retry: an upload or install must not run twice.
      mutations: { retry: false },
    },
  });
  return queryClient;
}
