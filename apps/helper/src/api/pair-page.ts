/**
 * The page that shows the pairing code. It must never be readable by another origin: whoever can
 * read it can pair. So no CORS headers (see cors() in middleware.ts), no framing, no caching.
 */
export const PAIR_PAGE_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export type PendingPairing = { code: string; clientName: string; expiresAt: Date };

export function renderPairPage(pending: PendingPairing | null, now: number): string {
  const body = pending
    ? `<p class="label">Pairing code for ${escapeHtml(pending.clientName)}</p>
    <p class="code">${escapeHtml(pending.code)}</p>
    <p>Type this code into the Font Sync plugin in Figma. It expires in ${minutesLeft(pending.expiresAt, now)}.</p>`
    : `<p class="label">No pairing request is waiting</p>
    <p>Open the Font Sync plugin in Figma and choose Pair to get a code.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Font Sync pairing</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; }
    main { max-width: 28rem; text-align: center; }
    .label { font-size: 1.1rem; font-weight: 600; }
    .code { font: 700 3.5rem/1.2 ui-monospace, monospace; letter-spacing: 0.15em; margin: 0.5rem 0; }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>
`;
}

function minutesLeft(expiresAt: Date, now: number): string {
  const minutes = Math.max(1, Math.ceil((expiresAt.getTime() - now) / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
