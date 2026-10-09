import type { FontKey, MainToUi, Prefs, ScanReport } from "../shared/messages";

export type ScanState =
  | { phase: "idle" }
  | { phase: "scanning"; pagesDone: number; pagesTotal: number }
  | { phase: "error"; message: string };

export type ReloadReason = "installed" | "uninstalled";

export type Selection = {
  font: FontKey;
  /** null while the main thread is still selecting. */
  result: { selected: number; pageName: string | null } | null;
};

/** State driven by the main thread, kept above the gate screens so it survives a helper restart. */
export type PluginState = {
  /** False until the main thread's init message arrives with the stored token and prefs. */
  ready: boolean;
  token: string | null;
  prefs: Prefs;
  scan: ScanState;
  /** The last finished scan. Kept while a new scan runs so the list does not flash empty. */
  report: ScanReport | null;
  selection: Selection | null;
  /** Set once fonts changed on disk; Figma only sees them after the file tab reloads. */
  reload: ReloadReason | null;
};

export type UiAction =
  | { type: "scan-started" }
  | { type: "prefs-changed"; prefs: Prefs }
  | { type: "token-changed"; token: string | null }
  | { type: "select-requested"; font: FontKey }
  | { type: "reload-needed"; reason: ReloadReason };

export const initialState: PluginState = {
  ready: false,
  token: null,
  prefs: { scope: "page", deep: false },
  scan: { phase: "idle" },
  report: null,
  selection: null,
  reload: null,
};

export function reducer(state: PluginState, action: MainToUi | UiAction): PluginState {
  switch (action.type) {
    case "init":
      return { ...state, ready: true, token: action.token, prefs: action.prefs };
    case "scan-started":
      return { ...state, scan: { phase: "scanning", pagesDone: 0, pagesTotal: 0 } };
    case "scan-progress":
      return { ...state, scan: { phase: "scanning", pagesDone: action.pagesDone, pagesTotal: action.pagesTotal } };
    case "scan-result":
      return { ...state, scan: { phase: "idle" }, report: action.report };
    case "scan-error":
      return { ...state, scan: { phase: "error", message: action.message } };
    case "select-requested":
      return { ...state, selection: { font: action.font, result: null } };
    case "select-result":
      // A result with nothing requested comes from a stale request; it has no font to describe.
      if (state.selection === null) return state;
      return {
        ...state,
        selection: { ...state.selection, result: { selected: action.selected, pageName: action.pageName } },
      };
    case "prefs-changed":
      return { ...state, prefs: action.prefs };
    case "token-changed":
      return { ...state, token: action.token };
    case "reload-needed":
      return { ...state, reload: action.reason };
  }
}

export function describeSelection(selection: Selection): string {
  const name = `${selection.font.family} ${selection.font.style}`;
  if (selection.result === null) return `Selecting layers that use ${name}...`;
  const { selected, pageName } = selection.result;
  if (selected === 0) return `No layers using ${name} were found.`;
  const layers = selected === 1 ? "1 layer" : `${selected} layers`;
  return pageName ? `Selected ${layers} using ${name} on ${pageName}.` : `Selected ${layers} using ${name}.`;
}
