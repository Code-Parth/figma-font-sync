import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { asApiError } from "./errors";
import type { Outcome } from "./library";

const AnnounceContext = createContext<(message: string) => void>(() => {});

/** Owns the single polite live region; screens report status changes through useAnnounce(). */
export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string[]>([]);

  const announce = useCallback((next: string) => {
    // Clear first: screen readers ignore a region whose text did not change. Messages that
    // arrive together are joined, so an install result is not replaced by the note that follows it.
    pending.current.push(next);
    setMessage("");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setMessage(pending.current.join(" "));
      pending.current = [];
    }, 50);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): (message: string) => void {
  return useContext(AnnounceContext);
}

export function ErrorText({ error, children }: { error?: unknown; children?: ReactNode }) {
  return (
    <p className="text-danger" role="alert">
      {children ?? asApiError(error).message}
    </p>
  );
}

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="screen">
      <h1 className="screen-title">{title}</h1>
      {children}
    </main>
  );
}

/** A shell command the user runs; one click selects all of it for copying. */
export function Command({ children }: { children: string }) {
  return <code className="command">{children}</code>;
}

export function Loading({ text }: { text: string }) {
  return (
    <main className="screen screen-center" aria-busy="true">
      <p className="text-secondary">{text}</p>
    </main>
  );
}

export function Outcomes({ outcomes }: { outcomes: Outcome[] }) {
  return (
    <ul className="outcomes">
      {outcomes.map((outcome, index) => (
        // A fixed snapshot of one response: position is a stable identity.
        <li key={index} className={`outcome tone-${outcome.tone}`}>
          {outcome.text}
        </li>
      ))}
    </ul>
  );
}
