import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useReducer, useState } from "react";
import type { FontKey, Prefs } from "../shared/messages";
import { getHealthOptions, getStatusOptions } from "./api/@tanstack/react-query.gen";
import { onMainMessage, postToMain } from "./bridge";
import { resetSession, setPairingToken } from "./connection";
import { asApiError } from "./errors";
import { plural } from "./format";
import { LibraryPicker } from "./screens/LibraryPicker";
import { Main } from "./screens/Main";
import { Pairing } from "./screens/Pairing";
import { NotConfigured, SignIn } from "./screens/SignIn";
import { Unreachable } from "./screens/Unreachable";
import { describeSelection, initialState, type ReloadReason, reducer } from "./state";
import { AnnounceProvider, ErrorText, Loading, Screen, useAnnounce } from "./ui";

/** The Unreachable screen moves on by itself: the longest a just-started helper goes unnoticed. */
const HEALTH_DOWN_POLL_MS = 2000;
/** Notices a helper that stopped while the plugin sits open. Cheap: /health is a local, unauthenticated GET. */
const HEALTH_UP_POLL_MS = 30_000;
/** Slower than the health poll: every status check calls Google Drive. */
const LIBRARY_ERROR_POLL_MS = 10_000;

export function App() {
  return (
    <AnnounceProvider>
      <Gate />
    </AnnounceProvider>
  );
}

/**
 * Shows the first screen whose precondition fails, in order: helper running, paired, Google
 * configured and signed in, library readable and chosen. Only then the main view.
 */
function Gate() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [choosingLibrary, setChoosingLibrary] = useState(false);

  useEffect(
    () =>
      onMainMessage((message) => {
        // Set before dispatch so queries enabled by the next render already send the token.
        if (message.type === "init") setPairingToken(message.token);
        if (message.type === "scan-result") {
          const missing = message.report.fonts.filter((font) => !font.availableInFigma).length;
          announce(`Scan finished: ${plural(message.report.fonts.length, "font")}, ${missing} missing in Figma.`);
        }
        if (message.type === "scan-error") announce(`Scan failed: ${message.message}`);
        dispatch(message);
      }),
    [announce],
  );

  useEffect(() => {
    if (state.selection?.result) announce(describeSelection(state.selection));
  }, [state.selection, announce]);

  const health = useQuery({
    ...getHealthOptions(),
    // Polling replaces retries here: a stopped helper should show its screen at once.
    retry: false,
    refetchInterval: (query) => (query.state.status === "error" ? HEALTH_DOWN_POLL_MS : HEALTH_UP_POLL_MS),
  });

  const status = useQuery({
    ...getStatusOptions(),
    enabled: state.ready && state.token !== null && health.isSuccess,
    refetchInterval: (query) => {
      // After the helper restarts, status can sit on a network error while health already recovered.
      if (query.state.status === "error") return asApiError(query.state.error).unreachable ? HEALTH_DOWN_POLL_MS : false;
      // Clears the "Can't read your font library" screen once Drive answers again.
      return query.state.data?.libraryError ? LIBRARY_ERROR_POLL_MS : false;
    },
  });

  const changeToken = useCallback(
    (token: string | null) => {
      setPairingToken(token);
      postToMain({ type: "save-token", token });
      dispatch({ type: "token-changed", token });
      void resetSession(queryClient);
    },
    [queryClient],
  );

  const onScan = useCallback(() => {
    dispatch({ type: "scan-started" });
    postToMain({ type: "scan", options: state.prefs });
  }, [state.prefs]);

  const onPrefs = useCallback((prefs: Prefs) => {
    dispatch({ type: "prefs-changed", prefs });
    postToMain({ type: "save-prefs", prefs });
  }, []);

  const onSelect = useCallback((font: FontKey) => {
    dispatch({ type: "select-requested", font });
    postToMain({ type: "select-font", font });
  }, []);

  const onReload = useCallback(
    (reason: ReloadReason) => {
      dispatch({ type: "reload-needed", reason });
      announce("Reload this tab so Figma picks up the font changes.");
    },
    [announce],
  );

  let screen: ReactNode;
  if (!state.ready || health.isPending) {
    screen = <Loading text="Connecting to the Font Sync helper..." />;
  } else if (health.isError) {
    screen = (
      <Unreachable paired={state.token !== null} checking={health.isFetching} onCheck={() => void health.refetch()} />
    );
  } else if (state.token === null) {
    screen = <Pairing revoked={false} onPaired={changeToken} />;
  } else if (status.isPending) {
    screen = <Loading text="Checking the helper..." />;
  } else if (status.isError) {
    const error = asApiError(status.error);
    screen =
      error.status === 401 ? (
        <Pairing revoked onPaired={changeToken} />
      ) : (
        <Screen title="Something went wrong">
          <ErrorText error={error} />
          <div className="actions">
            <button type="button" className="button secondary" onClick={() => void status.refetch()}>
              Try again
            </button>
          </div>
        </Screen>
      );
  } else if (status.data.auth === "not-configured") {
    screen = <NotConfigured checking={status.isFetching} onCheck={() => void status.refetch()} />;
  } else if (status.data.auth !== "signed-in") {
    screen = <SignIn status={status.data} />;
  } else if (status.data.library === null && status.data.libraryError !== null) {
    // Not the picker: a saved choice still stands, and asking again could make the user pick another folder.
    screen = (
      <Screen title="Can't read your font library">
        <p>The helper is signed in, but couldn't read your font library from Google Drive.</p>
        <ErrorText>{status.data.libraryError}</ErrorText>
        <div className="actions">
          <button
            type="button"
            className="button secondary"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            {status.isFetching ? "Checking..." : "Try again"}
          </button>
          <span className="text-tertiary">Checking again every 10 seconds.</span>
        </div>
      </Screen>
    );
  } else if (status.data.library === null || choosingLibrary) {
    screen = <LibraryPicker current={status.data.library} onDone={() => setChoosingLibrary(false)} />;
  } else {
    screen = (
      <Main
        status={status.data}
        library={status.data.library}
        version={health.data?.version}
        state={state}
        onScan={onScan}
        onPrefs={onPrefs}
        onSelect={onSelect}
        onReload={onReload}
        onChangeLibrary={() => setChoosingLibrary(true)}
        onUnpaired={() => changeToken(null)}
      />
    );
  }

  return <div className="app">{screen}</div>;
}
