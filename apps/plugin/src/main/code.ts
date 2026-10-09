// Plugin main thread entry. Owns figma.clientStorage and the document; the UI asks for everything
// through src/shared/messages.ts.

import type { MainToUi, UiToMain } from "../shared/messages";
import { scanFonts } from "./scan";
import { selectFont } from "./select";
import { DEFAULT_PREFS, clampUiSize, isOpenableUrl, parsePrefs, parseStoredToken, parseUiMessage } from "./validate";

const TOKEN_KEY = "pairToken";
const PREFS_KEY = "prefs";

let scanning = false;

function post(message: MainToUi): void {
  figma.ui.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handle(message: UiToMain): Promise<void> {
  switch (message.type) {
    case "scan":
      // Two scans would fight over skipInvisibleInstanceChildren and the node-id index.
      if (scanning) return;
      scanning = true;
      try {
        const report = await scanFonts(message.options, (pagesDone, pagesTotal) =>
          post({ type: "scan-progress", pagesDone, pagesTotal }),
        );
        post({ type: "scan-result", report });
      } catch (error) {
        post({ type: "scan-error", message: errorMessage(error) });
      } finally {
        scanning = false;
      }
      return;
    case "select-font":
      try {
        post({ type: "select-result", ...(await selectFont(message.font)) });
      } catch (error) {
        // The UI waits for a select-result; the notification below says why it is empty.
        post({ type: "select-result", selected: 0, pageName: null });
        throw error;
      }
      return;
    case "save-token":
      if (message.token) await figma.clientStorage.setAsync(TOKEN_KEY, message.token);
      else await figma.clientStorage.deleteAsync(TOKEN_KEY);
      return;
    case "save-prefs":
      await figma.clientStorage.setAsync(PREFS_KEY, message.prefs);
      return;
    case "open-external":
      if (isOpenableUrl(message.url)) figma.openExternal(message.url);
      return;
    case "notify":
      figma.notify(message.message, { error: message.error === true });
      return;
    case "resize": {
      const { width, height } = clampUiSize(message.width, message.height);
      figma.ui.resize(width, height);
      return;
    }
  }
}

async function init(): Promise<void> {
  const [token, prefs] = await Promise.all([
    figma.clientStorage.getAsync(TOKEN_KEY),
    figma.clientStorage.getAsync(PREFS_KEY),
  ]);
  post({ type: "init", token: parseStoredToken(token), prefs: parsePrefs(prefs) });
}

figma.showUI(__html__, { width: 400, height: 620, themeColors: true, title: "Font Sync" });

figma.ui.onmessage = (raw: unknown) => {
  const message = parseUiMessage(raw);
  if (!message) return;
  handle(message).catch((error: unknown) => figma.notify(errorMessage(error), { error: true }));
};

init().catch((error: unknown) => {
  // The UI waits for init before it starts; send one unpaired with defaults rather than leave it waiting.
  figma.notify(`Could not read saved settings: ${errorMessage(error)}`, { error: true });
  post({ type: "init", token: null, prefs: { ...DEFAULT_PREFS } });
});
