# Changelog

All notable changes to figma-font-sync. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). One version covers the
CLI, the Figma plugin and every npm package.

## [Unreleased]

### Added

- This changelog. Each release moves the entries below into its own section (`docs/releasing.md`).

### Changed

- `docs/releasing.md` describes what the first release needed: approving staged uploads with 2FA
  (npmjs.com **Staged Packages**, or `npm stage list` and `npm stage approve`), registry "not found"
  answers that can linger for a few minutes after approval, deprecating the `0.0.0-stage` placeholders,
  and `npm i -g npm@11` for Node versions older than 24.15.
- Releases published through trusted publishing now carry npm provenance, since the GitHub repository is
  public.
- GitHub release notes now come from the version's section in this file. The release workflow stops
  before publishing anything when the section is missing.

## [0.1.0] - 2026-10-09

First public release.

### Added

#### Figma plugin (Figma desktop)

- Scans every page, or only the current one, for the fonts used by text layers and local text styles.
  **Include hidden layers** also reads hidden layers inside instances.
- Gives each font a status: **Install** (missing in Figma, the library has it), **Not in library**,
  **Add to library** (installed here, you can upload it), **Synced**, **Provided by Figma** (Google Fonts
  and fonts uploaded to Figma), **Reload tab** (installed, but Figma has not loaded it yet),
  **Replace font** (the library has it under a different name) and **Local only**.
- **Install all missing**, and selecting the layers that use a font by clicking its name.
- **Library** tab: every font in the shared Drive folder, with search, Install, Update, Uninstall,
  drag-and-drop upload for editors, Remove, the folder's members and **Open in Google Drive**.
- **Settings** tab: account, sign out, change library, unpair, helper version.
- When the helper is not answering, shows the command to start it (or, if this plugin was never paired,
  the install commands), worded for Terminal, Command Prompt or PowerShell, with a Copy button. It
  continues on its own within 2 seconds of the helper answering.

#### Helper and CLI (`figma-font-sync`)

- `setup`: stores your team's Google OAuth client, writes the plugin files and prints the manifest path to
  import in Figma, turns on start at login and offers sign-in. Takes `--client-id`, `--client-secret`,
  `--no-autostart`, `--no-login` and `--yes`.
- `start`, `stop`, `restart` and `serve` run the helper on `http://localhost:47321`; `status` and
  `doctor` report on it, and `doctor` says how to fix each problem it finds.
- `login`, `logout`, `library list`, `library use`, `library create`, `sync [--dry-run]`,
  `autostart enable|disable|status`, `pairs list|revoke-all`, `plugin`, `uninstall [--purge]`,
  `version` and `help`.
- Google sign-in through a Desktop-app OAuth client (loopback redirect with PKCE). The sign-in stays in the
  OS keychain and never reaches the plugin.
- The library is a Google Drive folder named `font-sync-figma-plugin`, and Drive sharing is the
  permission model: editors add and remove fonts, viewers install. Faces parsed by one person are shared
  through `font-sync-index.json` in the folder.
- Fonts are matched by the same `{family, style}` names Figma uses (typographic family and subfamily,
  one style per variable-font instance).
- Installs fonts for the current user without admin rights: `~/Library/Fonts` on macOS, the per-user
  Fonts folder plus a registry entry on Windows, `~/.local/share/fonts/font-sync` on Linux. Installed files
  are never overwritten.
- Start at login through a LaunchAgent on macOS, a systemd user unit on Linux, and the Run key on Windows
  using a copy of the exe with no console window. The background helper runs from a versioned copy in the
  per-user data folder, so npm upgrades never replace a running executable.
- The plugin files are built into the binary and rewritten whenever the version changes, so the manifest
  path you imported keeps working across upgrades.

#### Distribution

- `npm i -g figma-font-sync`: a small Node launcher with exact-pinned platform packages
  `@figma-font-sync/darwin-arm64`, `darwin-x64`, `windows-x64` and `linux-x64`. Bun is not required.
- `curl -fsSL https://unpkg.com/figma-font-sync/install.sh | sh` on macOS and Linux: downloads the same
  platform package from the npm registry and verifies npm's registry signature against a pinned key, and
  the tarball's sha512, before installing to `~/.local/bin`.
- Binaries for every platform are attached to the GitHub release.

### Security

- Every helper route except `/health` and pairing needs a token from pairing with a 6-digit code shown on
  a local page that other sites cannot read. Twenty wrong codes lock pairing until the helper restarts.
- The helper listens only on `127.0.0.1` and `::1` and rejects requests for any other host name.
- Published builds never contain a Google client; each team supplies its own.

### Known limitations

- Figma desktop only: development plugins do not run in Figma in a browser. On Linux, which has no Figma
  desktop app, only the CLI's `sync` is useful.
- After installing, Figma may not list a font until you reload the file tab (right-click the tab >
  **Reload tab**).
- Fonts used only on text-on-a-path layers are not scanned: Figma's plugin runtime rejects `TEXT_PATH`
  searches. They will be picked up once Figma accepts them.
- On Windows, if Figma does not list a per-user font after a tab reload, install that file for all users
  by hand.
- One Google account per computer user, and one library at a time.
- macOS system fonts larger than 50 MB (PingFang, Songti, Apple Color Emoji) are skipped by the local scan
  and show as **Provided by Figma**.
- Needs macOS 13 or newer, or Windows 10 version 1809 or newer.
- 0.1.0 was published with a token and has no npm provenance.

[Unreleased]: https://github.com/Code-Parth/figma-font-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Code-Parth/figma-font-sync/releases/tag/v0.1.0
