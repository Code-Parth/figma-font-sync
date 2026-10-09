// Messages between the plugin main thread (src/main) and the UI iframe (src/ui).
// Only structured-cloneable data crosses postMessage: no Blob, no ArrayBuffer.

export type FontKey = { family: string; style: string };

export type ScanScope = "page" | "document";

export type ScanOptions = {
  scope: ScanScope;
  /** Include hidden layers inside instances (sets figma.skipInvisibleInstanceChildren = false). */
  deep: boolean;
};

export type FontUsage = FontKey & {
  /** Text and text-path nodes that use this font in at least one range. */
  nodeCount: number;
  /** Nodes using this font whose hasMissingFont is true. */
  missingNodeCount: number;
  pages: { id: string; name: string }[];
  /** Local text styles whose fontName is this font. */
  textStyles: string[];
  /** In figma.listAvailableFontsAsync() at scan time. */
  availableInFigma: boolean;
};

export type ScanReport = {
  fileName: string;
  scope: ScanScope;
  deep: boolean;
  /** Date.now() when the scan finished. */
  scannedAt: number;
  nodeCount: number;
  fonts: FontUsage[];
};

export type Prefs = { scope: ScanScope; deep: boolean };

export type MainToUi =
  | { type: "init"; token: string | null; prefs: Prefs }
  | { type: "scan-progress"; pagesDone: number; pagesTotal: number }
  | { type: "scan-result"; report: ScanReport }
  | { type: "scan-error"; message: string }
  | { type: "select-result"; selected: number; pageName: string | null };

export type UiToMain =
  | { type: "scan"; options: ScanOptions }
  | { type: "select-font"; font: FontKey }
  | { type: "save-token"; token: string | null }
  | { type: "save-prefs"; prefs: Prefs }
  /** Only https://drive.google.com/ and https://docs.google.com/ URLs are opened. */
  | { type: "open-external"; url: string }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "resize"; width: number; height: number };
