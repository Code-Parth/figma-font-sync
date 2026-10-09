import type { MainToUi, UiToMain } from "../shared/messages";

type Listener = (message: MainToUi) => void;

const listeners = new Set<Listener>();
// The main thread posts init right after showUI, possibly before React has subscribed.
const early: MainToUi[] = [];
let listening = false;

// Anything else is dropped before it reaches the reducer, which has no case for it and would return
// undefined, unmounting the whole UI.
const MAIN_TO_UI_TYPES: ReadonlySet<string> = new Set<MainToUi["type"]>([
  "init",
  "scan-progress",
  "scan-result",
  "scan-error",
  "select-result",
]);

export function readMessage(data: unknown): MainToUi | null {
  if (typeof data !== "object" || data === null || !("pluginMessage" in data)) return null;
  const message = data.pluginMessage;
  if (typeof message !== "object" || message === null || !("type" in message) || typeof message.type !== "string") {
    return null;
  }
  return MAIN_TO_UI_TYPES.has(message.type) ? (message as MainToUi) : null;
}

/** Starts collecting main-thread messages. Call before rendering so init is never missed. */
export function listenToMain(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = readMessage(event.data);
    if (message === null) return;
    if (listeners.size === 0) early.push(message);
    for (const listener of listeners) listener(message);
  });
}

export function onMainMessage(listener: Listener): () => void {
  listenToMain();
  listeners.add(listener);
  for (const message of early.splice(0)) listener(message);
  return () => {
    listeners.delete(listener);
  };
}

export function postToMain(message: UiToMain): void {
  parent.postMessage({ pluginMessage: message }, "*");
}
