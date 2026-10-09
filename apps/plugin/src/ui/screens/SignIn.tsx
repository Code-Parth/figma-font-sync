import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getStatusOptions, getStatusQueryKey } from "../api/@tanstack/react-query.gen";
import { login } from "../api/sdk.gen";
import type { Status } from "../api/types.gen";
import { Command, ErrorText, Screen, useAnnounce } from "../ui";

const POLL_MS = 2000;
/** Long enough to create a Google account mid-flow; short enough not to poll a forgotten tab all day. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

export function NotConfigured({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  return (
    <Screen title="Google sign-in isn't set up">
      <p>
        The helper has no Google OAuth client, so it can't sign in to Google Drive. Ask your admin for the team's client
        id and secret, then run this in a terminal and enter them:
      </p>
      <Command copy>figma-font-sync setup</Command>
      <p>The helper picks the client up without a restart. The Font Sync README explains how to create one.</p>
      <div className="actions">
        <button type="button" className="button secondary" onClick={onCheck} disabled={checking}>
          {checking ? "Checking..." : "Check again"}
        </button>
      </div>
    </Screen>
  );
}

/** For auth "signed-out", "expired" and "signing-in". */
export function SignIn({ status }: { status: Status }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  // Opening the plugin while the helper is already mid sign-in starts the wait straight away.
  const [deadline, setDeadline] = useState<number | null>(() =>
    status.auth === "signing-in" ? Date.now() + SIGN_IN_TIMEOUT_MS : null,
  );
  const [timedOut, setTimedOut] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(() => setTimedOut(true), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);

  const polling = deadline !== null && !timedOut;
  // A second observer on the status query: the gate re-renders on its own once auth flips to signed-in.
  useQuery({ ...getStatusOptions(), refetchInterval: polling ? POLL_MS : false });

  const start = useMutation({
    mutationFn: async () => (await login({ throwOnError: true })).data,
    onSuccess: async (data) => {
      setUrl(data.url);
      setTimedOut(false);
      setDeadline(Date.now() + SIGN_IN_TIMEOUT_MS);
      announce("A browser window opened for Google sign-in.");
      // Wait for the new auth state so the screen does not flash the signed-out view.
      await queryClient.invalidateQueries({ queryKey: getStatusQueryKey() });
    },
  });

  const keepWaiting = () => {
    setTimedOut(false);
    setDeadline(Date.now() + SIGN_IN_TIMEOUT_MS);
    void queryClient.invalidateQueries({ queryKey: getStatusQueryKey() });
  };

  if (status.auth === "signing-in" && !timedOut) {
    return (
      <Screen title="Finish signing in">
        <p>Continue in the browser window that opened, then come back here. This screen updates by itself.</p>
        {url !== null ? <LoginLink url={url} /> : null}
        <div className="actions">
          <button type="button" className="button secondary" onClick={() => start.mutate()} disabled={start.isPending}>
            Start again
          </button>
        </div>
        {start.isError ? <ErrorText error={start.error} /> : null}
      </Screen>
    );
  }

  if (status.auth === "signing-in") {
    return (
      <Screen title="Still waiting for Google">
        <p>Sign-in didn't finish within 10 minutes, so the plugin stopped checking.</p>
        <div className="actions">
          <button type="button" className="button primary" onClick={() => start.mutate()} disabled={start.isPending}>
            Sign in with Google
          </button>
          <button type="button" className="button secondary" onClick={keepWaiting}>
            Keep waiting
          </button>
        </div>
        {start.isError ? <ErrorText error={start.error} /> : null}
      </Screen>
    );
  }

  return (
    <Screen title={status.auth === "expired" ? "Sign in again" : "Sign in with Google"}>
      {status.auth === "expired" ? (
        <p>
          Your Google sign-in has expired. If this happens about once a week, the OAuth app is still in Testing; ask
          your admin to publish it.
        </p>
      ) : (
        <p>Sign in with the Google account that has access to your team's font library in Google Drive.</p>
      )}
      {start.isSuccess ? <p className="text-secondary">Sign-in didn't finish. Try again.</p> : null}
      <div className="actions">
        <button type="button" className="button primary" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? "Opening browser..." : "Sign in with Google"}
        </button>
      </div>
      {start.isError ? <ErrorText error={start.error} /> : null}
    </Screen>
  );
}

function LoginLink({ url }: { url: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor="login-url">
        No window? Copy this link into your browser:
      </label>
      <input
        id="login-url"
        className="input mono"
        readOnly
        value={url}
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}
