import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { copyText } from "./clipboard";
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

const COPIED_MS = 1500;

/**
 * A shell command the user runs. One click on the text selects all of it, which stays the manual way to copy
 * when the Copy button can't reach the clipboard.
 */
export function Command({ children, copy = false }: { children: string; copy?: boolean }) {
  return copy ? <CopyableCommand command={children} /> : <code className="command">{children}</code>;
}

function CopyableCommand({ command }: { command: string }) {
  const announce = useAnnounce();
  const id = useId();
  const code = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = () => {
    clearTimeout(timer.current);
    if (copyText(command)) {
      setCopied(true);
      announce("Copied to the clipboard.");
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      return;
    }
    setCopied(false);
    // Leaves the command selected, so the user's own copy shortcut picks it up.
    if (code.current !== null) document.getSelection()?.selectAllChildren(code.current);
    announce("Couldn't copy automatically. The command is selected; copy it with your keyboard.");
  };

  return (
    <div className="command-row">
      <code id={id} ref={code} className="command">
        {command}
      </code>
      <button type="button" className="button secondary small command-copy" aria-describedby={id} onClick={onCopy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
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
