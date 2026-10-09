import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { completePairing, startPairing } from "../api/sdk.gen";
import { HELPER_URL } from "../connection";
import { asApiError } from "../errors";
import { formatTime } from "../format";
import { ErrorText, Screen, useAnnounce } from "../ui";

const CLIENT_NAME = "Figma plugin";

function startErrorText(error: unknown): string {
  const apiError = asApiError(error);
  // A start a few seconds ago and a pairing lock both arrive as rate-limited; only the message tells them apart.
  return apiError.message;
}

function completeErrorText(error: unknown): string {
  const apiError = asApiError(error);
  if (apiError.status === 401) return "That code doesn't match, or it has expired. Check the browser tab and try again.";
  // Rate-limited is a burned code or a locked helper; the helper's message says which.
  if (apiError.code === "rate-limited") return apiError.message;
  if (apiError.status === 400) return "Enter the 6 digits shown in the browser tab.";
  return apiError.message;
}

/** `revoked`: a stored token exists but the helper refused it. */
export function Pairing({ revoked, onPaired }: { revoked: boolean; onPaired: (token: string) => void }) {
  const announce = useAnnounce();
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const complete = useMutation({
    mutationFn: async (value: string) =>
      (await completePairing({ body: { code: value, clientName: CLIENT_NAME }, throwOnError: true })).data,
    onSuccess: (data) => {
      announce("Paired with the helper.");
      onPaired(data.token);
    },
    onError: (error) => {
      announce(completeErrorText(error));
      setCode("");
      input.current?.focus();
    },
  });

  const start = useMutation({
    mutationFn: async () => (await startPairing({ body: { clientName: CLIENT_NAME }, throwOnError: true })).data,
    onSuccess: (data) => {
      complete.reset();
      setCode("");
      setExpiresAt(data.expiresAt);
      announce("A browser tab opened with a pairing code.");
    },
  });

  const burned = complete.isError && asApiError(complete.error).code === "rate-limited";

  const submit = (value: string) => {
    if (value.length === 6 && !complete.isPending && !burned) complete.mutate(value);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(code);
  };

  if (expiresAt === null) {
    return (
      <Screen title="Pair with the helper">
        {revoked ? (
          <p>
            The helper no longer accepts this plugin's pairing. It was revoked, or the helper's settings were reset.
            Pair again to continue.
          </p>
        ) : (
          <p>
            The helper is running. Pair this plugin with it once so other web pages can't use it. Pairing opens a
            browser tab that shows a 6-digit code.
          </p>
        )}
        <div className="actions">
          <button type="button" className="button primary" onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? "Starting..." : "Pair"}
          </button>
        </div>
        {start.isError ? <ErrorText>{startErrorText(start.error)}</ErrorText> : null}
      </Screen>
    );
  }

  return (
    <Screen title="Enter the pairing code">
      <p id="pair-help">
        A browser tab opened at <span className="mono">{HELPER_URL}/pair</span> with a 6-digit code. Type or paste it
        here. If no tab opened, open that address yourself. The code expires at {formatTime(expiresAt)}.
      </p>
      <form className="pair-form" onSubmit={onSubmit}>
        <label className="field-label" htmlFor="pair-code">
          Pairing code
        </label>
        <div className="actions">
          <input
            id="pair-code"
            ref={input}
            className="input code-input"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            value={code}
            disabled={burned}
            aria-describedby="pair-help"
            aria-invalid={complete.isError}
            onChange={(event) => {
              // Strip spaces and dashes so a pasted "123 456" still works.
              const next = event.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(next);
              submit(next);
            }}
          />
          <button type="submit" className="button primary" disabled={code.length !== 6 || complete.isPending || burned}>
            {complete.isPending ? "Pairing..." : "Pair"}
          </button>
        </div>
      </form>
      {complete.isError ? <ErrorText>{completeErrorText(complete.error)}</ErrorText> : null}
      {start.isError ? <ErrorText>{startErrorText(start.error)}</ErrorText> : null}
      <div className="actions">
        <button
          type="button"
          className={burned ? "button primary" : "button secondary"}
          onClick={() => start.mutate()}
          disabled={start.isPending}
        >
          {start.isPending ? "Starting..." : "Get a new code"}
        </button>
      </div>
    </Screen>
  );
}
