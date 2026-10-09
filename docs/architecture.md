# Font Sync architecture

A Figma plugin plus a per-machine helper that share one font library stored in a Google Drive
folder named `font-sync-figma-plugin`. Drive sharing on that folder is the permission model.
How it is packaged, installed and kept running (npm, binaries, `setup`, start at login):
`docs/distribution.md`.

## Why the pieces are shaped this way

| Constraint (verified Oct 2026) | Consequence |
|---|---|
| Plugins cannot write to disk or install fonts | A helper process on each machine installs fonts |
| Figma's only OAuth pattern for plugins needs a public HTTPS server; we host nothing | The helper does Google sign-in itself (Desktop client, loopback redirect, PKCE). The plugin never sees Google tokens |
| `drive.file` is per user and per file: B cannot see fonts A uploaded, even in a folder shared with B, and picking a folder does not grant its children | The helper requests the restricted `https://www.googleapis.com/auth/drive` scope. Workspace: consent screen "Internal". Gmail: "External", published "In production" (unverified, under 100 users). "Testing" only to try it: refresh tokens die after 7 days |
| The helper is a public npm package, and anyone can read the strings in a published binary | No Google client ships in it. Each team creates its own Desktop-app client; the helper takes `FONT_SYNC_GOOGLE_CLIENT_ID`/`_SECRET` from the env, else `googleClient` in `config.json` (written by `figma-font-sync setup`), else one baked in by a private build |
| Plugin iframes have origin `null`; manifest `allowedDomains` rejects IP literals | The plugin calls `http://localhost:47321`; the helper listens on both `127.0.0.1` and `::1` |
| Any web page can send `Origin: null`; every plugin shares figma.com's loopback grant | Every helper route except `/health` and pairing needs a bearer token issued by pairing |
| The Plugin API exposes only `{family, style}`, never a PostScript name | The helper must compute Figma's exact `{family, style}` from font files |
| Figma's naming rule (verified on 1,351 of 1,352 faces): family = name ID 16 else 1; style = name ID 17 else 2; variable fonts give one style per `fvar` named instance; families starting with `.` are hidden | `fonts/sfnt.ts` implements exactly this |
| `listAvailableFontsAsync` includes Google Fonts, Figma-uploaded fonts and local fonts with no source field | "Missing in Figma" comes from the plugin; "installed on this OS" comes from the helper's disk scan |
| Figma desktop cannot start programs for a plugin: `figma.openExternal` allows only http, https, mailto and tel | The helper starts at login once `setup` has run; when the plugin cannot reach it, it shows `figma-font-sync start` to copy and polls `/health` |
| Figma may not see a newly installed font until the file tab reloads | After installing, the UI tells the user to reload the tab (right-click tab > Reload tab) and re-scan |
| Windows locks loaded font files; Drive files can change | Installed files are named `<PostScriptName>-<md5 8>.<ext>`, never overwritten; old versions are deleted lazily |
| In a personal My Drive folder only the owner of a file can trash it | "Remove from library" trashes when `capabilities.canTrash`, otherwise removes the file from the folder |

## Components

```
Figma desktop app
  plugin main thread (src/main)   scans text nodes, owns figma.clientStorage, selects layers
        | postMessage (src/shared/messages.ts)
  plugin UI iframe (src/ui)       React + TanStack Query + generated client
        | HTTP, Authorization: Bearer <pair token>
helper (apps/helper)              Bun process on 127.0.0.1/::1:47321, runs as the logged-in user
  api/       Hono OpenAPI app: host check, CORS, auth, routes
  google/    OAuth (loopback + PKCE), Drive v3 REST client (fetch)
  library/   folder discovery, listing, shared face index, resolve, install, upload, remove
  fonts/     sfnt parser, Figma key + matching, local font scan
  install/   per-OS install and uninstall
  service/   autostart (LaunchAgent, HKCU Run key, systemd --user)
  cli/       setup, start/stop, doctor, uninstall: runtime copy in <dataDir>/bin, plugin files, helper.pid
  config/    per-OS paths, config.json (incl. the Google client), OS keychain via Bun.secrets
        | HTTPS
Google Drive folder "font-sync-figma-plugin"
  *.ttf *.otf *.ttc *.otc (any depth)  + font-sync-index.json (shared face cache)
```

## Library model

- **Discovery**: after sign-in the helper lists folders named `font-sync-figma-plugin` the user can see.
  One match is selected automatically; several matches need a choice; none offers "Create library"
  (that user becomes the owner and shares the folder with the team in Drive).
- **Listing**: walk the folder recursively; font files are recognised by extension
  (`.ttf .otf .ttc .otc`). Anything else is ignored.
- **Faces**: a file's faces are found in this order: local cache keyed by `fileId:md5`, then the shared
  `font-sync-index.json` entry with the same md5, then download and parse. A user who can add files to
  the folder writes newly parsed entries back to `font-sync-index.json`. The index is a cache:
  last writer wins, and a lost update only costs another parse. Never trust it over the file's md5.
- **Roles** come from Drive capabilities on the folder, read at runtime:
  `canAddChildren` means the user can upload; per-file `canTrash` / folder `canRemoveChildren` decide removal.
- **Upload** accepts only sfnt files (`0x00010000`, `true`, `OTTO`, `ttcf`), max 50 MB, rejects WOFF/WOFF2,
  and skips a file whose md5 already exists in the library.

## Status of a font used in the file

The UI combines four signals per `{family, style}`:

| Signal | Source |
|---|---|
| used in file | plugin scan |
| available in Figma | `figma.listAvailableFontsAsync()` re-read on every scan |
| in library | helper `POST /fonts/resolve` (tiers: exact, normalized, alias) |
| on this machine | helper local scan (and whether the helper installed it) |

Missing in Figma + in library = **Install**. Missing + not in library = **Not in library**.
Available + on this machine + not in library + user can upload = **Add to library**.
Available but not on this machine = **Provided by Figma** (Google Fonts, uploaded fonts).

## Pairing

1. UI calls `POST /pair/start`. The helper creates a 6-digit code (5 min, one pending at a time,
   at most one start every 10 s), logs it, and opens `http://localhost:47321/pair` in the browser.
2. That page shows the code. It is served without CORS headers and with `frame-ancestors 'none'`,
   so other sites and plugins cannot read it.
3. The user types the code into the plugin; `POST /pair/complete` returns a 256-bit token.
   Five wrong attempts burn the code. Twenty wrong codes since the last successful pairing lock pairing
   until the helper restarts, because a new start replaces the code and would otherwise reset the count.
4. The helper stores only `sha256(token)`. The plugin main thread stores the token in `figma.clientStorage`.

## Explicitly out of scope

Safari and browser Figma (development plugins only load in Figma desktop), Community publishing,
font licence management, editing Drive sharing from the plugin (use "Open in Drive").
