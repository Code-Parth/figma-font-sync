# Distribution

How Font Sync reaches a designer's machine, and why it is shaped this way. Research behind it
(October 2026): Bun 1.4 compile internals, the npm per-platform binary pattern, npm trusted
publishing, and Figma desktop's URL handling.

## What a user runs

```bash
npm i -g figma-font-sync        # or, on macOS/Linux without Node:
curl -fsSL https://unpkg.com/figma-font-sync/install.sh | sh
figma-font-sync setup           # Google client, plugin files, start at login, sign in
```

Then Figma desktop: Plugins > Development > Import plugin from manifest, and pick the path `setup` printed.
Windows has no curl installer; it uses npm. The Google client each team creates is described in
`README.md` ("Google Cloud setup"), which is also the npm package page.

## Packages

| Package | Contents |
|---|---|
| `figma-font-sync` | `bin/figma-font-sync.js` (CommonJS Node launcher), `install.sh`, README, LICENSE. `optionalDependencies` pinned to the exact same version of every platform package |
| `@figma-font-sync/darwin-arm64` | `bin/figma-font-sync` |
| `@figma-font-sync/darwin-x64` | `bin/figma-font-sync` |
| `@figma-font-sync/windows-x64` | `bin/figma-font-sync.exe`, `bin/figma-font-sync-background.exe` |
| `@figma-font-sync/linux-x64` | `bin/figma-font-sync` (`libc: ["glibc"]`) |

- Platform packages set `os`, `cpu`, `preferUnplugged: true`, `files: ["bin"]`, `repository.url`,
  `license`, `publishConfig.access: "public"`. Names say `windows`, not `win32`.
- The scope stops anyone from squatting a platform name the main package lists.
- No `postinstall`: npm 12 and pnpm 10 skip dependency lifecycle scripts by default.
- Linux has no Figma desktop app; the linux package exists for `figma-font-sync sync` and CI.

### The launcher

`packaging/npm/bin/figma-font-sync.js`. Resolves `@figma-font-sync/<os>-<arch>/package.json` with
`require.resolve`, checks that its version equals the launcher's, and runs `bin/figma-font-sync[.exe]` with `process.argv.slice(2)` and inherited
stdio. It forwards SIGINT/SIGTERM/SIGHUP and re-raises the child's signal, otherwise exits with its code.
On Windows it only stays alive through those signals: the console already sends Ctrl+C to the child, and
`child.kill` there is TerminateProcess, which would skip the helper's shutdown.
`FIGMA_FONT_SYNC_BINARY` overrides the path. A missing platform package (`--omit=optional`, an
unsupported platform) prints what to do and exits 1.

## Binaries

Built by `apps/helper/scripts/build.ts` with Bun 1.4.2, one `Bun.build` per target, into
`apps/helper/dist/`:

| Target | Output |
|---|---|
| `bun-darwin-arm64` | `figma-font-sync-darwin-arm64` |
| `bun-darwin-x64` | `figma-font-sync-darwin-x64` |
| `bun-windows-x64` | `figma-font-sync-windows-x64.exe`, `figma-font-sync-windows-x64-background.exe` (`windows.hideConsole`) |
| `bun-linux-x64` | `figma-font-sync-linux-x64` |

- **The plugin is embedded.** The build stages `apps/helper/dist/figma-plugin/` (manifest.json,
  dist/code.js, dist/ui.html) first and passes it as `compile.assets`. Inside the binary it is at
  `join(import.meta.dir, "figma-plugin")` when `Bun.isStandaloneExecutable`; from source it is
  `apps/plugin/`. Copy out manifest.json and the files its `main` and `ui` name with `Bun.file` +
  `Bun.write`: `fs.cp` fails on `/$bunfs` in Bun 1.4.0.
- **Darwin binaries are re-signed** ad hoc with `codesign --force --sign -` on macOS and checked with
  `codesign --verify --strict`. Bun before 1.4.1 writes an invalid arm64 signature, and Bun never
  re-signs x64 outputs; macOS 27 kills binaries with invalid pages.
- **No Google client in public builds.** `FONT_SYNC_PUBLIC_BUILD=1` makes the build fail if
  `FONT_SYNC_GOOGLE_CLIENT_ID` or `_SECRET` is set. The release workflow always sets it.
- Not quarantined: curl and npm do not set `com.apple.quarantine`, and Gatekeeper only assesses
  quarantined files, so ad-hoc signed binaries run without notarization. Never offer a browser download.
- Bun needs macOS 13 or newer.

## On the user's machine

`Paths.dataDir`, from `resolvePaths`:

| OS | dataDir |
|---|---|
| macOS | `~/Library/Application Support/font-sync` |
| Windows | `%LOCALAPPDATA%\font-sync` |
| Linux | `$XDG_DATA_HOME/font-sync` (`~/.local/share/font-sync`) |

```
<dataDir>/
  bin/figma-font-sync-<version>[.exe]              the copy the background helper runs
  bin/figma-font-sync-<version>-background.exe     Windows only
  figma-plugin/manifest.json, dist/code.js, dist/ui.html, .version
```

- **The background helper never runs from where npm put the binary.** pnpm's global path is versioned,
  and Windows refuses to replace a running .exe, so `npm i -g` fails with EBUSY while the helper runs
  from `node_modules`. `setup`, `start` and `autostart enable` copy the running binary to
  `<dataDir>/bin/` under a versioned name and register that copy. Older copies are deleted when not locked.
- **Plugin files are rewritten** whenever the stored `.version` differs from the binary's: on `setup`,
  `start`, `plugin` and every `serve` start. Figma reads development plugins from disk, so the manifest
  path users imported keeps working across upgrades.
- **The Google client lives in `config.json`** (`googleClient: { clientId, clientSecret }`, file mode
  0600). Precedence: `FONT_SYNC_GOOGLE_CLIENT_ID`/`_SECRET` env, then config.json, then a client baked in
  by a private build. The helper re-reads config.json and follows a changed client (except during a
  sign-in it started), so `setup` takes effect without a restart. A Desktop-app client secret is not
  confidential (Google: installed apps cannot keep secrets), but it is still kept out of logs and out
  of public builds.

## CLI

Command name: `figma-font-sync`. New and changed commands:

| Command | Does |
|---|---|
| `setup [--client-id <id>] [--client-secret <secret>] [--no-autostart] [--no-login] [--yes]` | 1. Google client: keep, or prompt (flags skip the prompt). A `--client-id` that changes the client in effect signs out first: Google ties a refresh token to the client that got it. 2. Install the runtime copy and plugin files, print the manifest path and the Figma import steps. 3. Enable start at login (default yes; default no when run from source, which would register the checkout) and start the helper. A helper `start` spawned is stopped before enabling on macOS and Linux. 4. Offer sign-in (default yes). Without a TTY it never prompts. |
| `start` | Idempotent. Refreshes runtime copy and plugin files. If the helper answers `/health` with this version: done. With another version: stop it first. If start-at-login is registered, starts through the service manager (`launchctl kickstart -k gui/<uid>/<label>`, `systemctl --user restart`); otherwise spawns the runtime copy's `serve` detached (Windows: the background exe) with output appended to `<stateDir>/font-sync.log`. If the service manager refuses (on macOS, the LaunchAgent switched off under Login Items), spawns the runtime copy anyway and prints how to fix it. Waits up to 10 s for `/health`. |
| `stop` | macOS with a LaunchAgent: `launchctl bootout` (KeepAlive would respawn a killed process; it starts again at next login). Linux with the unit: `systemctl --user stop`. Otherwise: SIGTERM the pid in `<stateDir>/helper.pid` after checking it is ours. |
| `restart` | `stop` then `start`. |
| `autostart enable` | Registers the runtime copy. On macOS and Linux it first stops a helper that `start` spawned: launchd and systemd start the registered one at once, and two cannot share the port. |
| `plugin` | Writes the plugin files if missing or stale and prints the manifest path plus import steps. |
| `doctor` | One line per check (ok / warn / fail) with the fix: platform, Google client (and its source), sign-in, library, helper running and version, start at login, plugin files, Figma desktop installed. Exit 1 if any check fails. |
| `uninstall [--purge] [--yes]` | Stops the helper, disables start at login, deletes `<dataDir>/bin` and `<dataDir>/figma-plugin` (not all of `<dataDir>`: on macOS it is also the config and state folder, on Windows the state folder). `--purge` also deletes config, state, cache and the stored Google sign-in. Installed fonts stay. Prints how to remove the CLI itself. |
| `serve` | As before, plus: writes `<stateDir>/helper.pid` (`{ pid, port, version, startedAt }`, removed on clean exit) and refreshes plugin files on start. |

Unchanged: `login`, `logout`, `status`, `library list|use|create`, `sync [--dry-run]`,
`autostart disable|status`, `pairs list|revoke-all`, `version`, `help`.

## The plugin when the helper is not running

Figma desktop cannot launch anything for a plugin. `figma.openExternal` allows only http, https, mailto
and tel, and the desktop main process allowlists schemes again, so a `figma-font-sync://` handler would
never be reached. Like Figma's own font agent, the helper is meant to always run (start at login is on
after `setup`), and the plugin's "not running" screen covers the rest:

- Paired before (a token is in clientStorage): "Start the helper", each command with a copy button. On
  macOS and Linux `figma-font-sync autostart enable` comes first (it also starts the helper), with
  `figma-font-sync start` for this time only. On Windows `start` comes first, then `autostart enable`,
  since the Run key starts nothing until the next login.
- Never paired: "Install Font Sync": `npm i -g figma-font-sync` (or the curl line on macOS), then
  `figma-font-sync setup`.
- OS from `navigator.userAgent`: say Terminal on macOS, Command Prompt on Windows. PowerShell blocks
  npm's `.ps1` shim under the default execution policy, so the Windows line is `figma-font-sync.cmd start`
  when shown for PowerShell.
- Copy uses an off-screen textarea and `document.execCommand("copy")` in the click handler;
  `navigator.clipboard` is blocked in the plugin iframe without an undocumented manifest permission.
- No `Electron/` in the user agent means Figma in a browser: say the desktop app is required.
- Poll `/health` every 2 s and continue as soon as it answers.

## install.sh

`packaging/install.sh`, shipped in the main npm package and served by unpkg. POSIX sh, every step in a
function, `main "$@"` on the last line so a truncated download runs nothing.

1. Platform: `uname -s` Darwin or Linux (MINGW/MSYS/CYGWIN: point to npm). `uname -m` x86_64/amd64 to x64,
   arm64/aarch64 to arm64; on Darwin x64, `sysctl -n sysctl.proc_translated` = 1 means Rosetta, use arm64.
   Linux arm64 and musl: unsupported (npm has no build for them either), so it lists the supported platforms.
2. Version: the one the script was published with (`pack-npm.ts` replaces `__VERSION__`), or
   `FIGMA_FONT_SYNC_VERSION`.
3. `GET https://registry.npmjs.org/@figma-font-sync%2F<os>-<arch>/<version>`: read `dist.tarball`,
   `dist.integrity` and the signature whose keyid is the pinned npm key
   `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`.
4. Verify the ECDSA signature over `<name>@<version>:<integrity>` with openssl and the pinned key, then
   the tarball's sha512 against `integrity`. Abort if openssl is missing or either check fails.
5. Extract the whole tarball into a `mktemp -d` dir (trap cleanup); copy `package/bin/figma-font-sync` to
   `${FIGMA_FONT_SYNC_INSTALL_DIR:-$HOME/.local/bin}`. No sudo. Print the PATH line for the user's shell
   if the dir is not on PATH.
6. Run `figma-font-sync setup </dev/tty` when a terminal is available, unless `--no-setup`.

`--from <tarball>` installs from a local platform tarball, skipping the registry and signature, for CI.

## Releasing

`.github/workflows/release.yml`, on a `v*` tag, on a GitHub-hosted macOS arm64 runner:

1. Tag must equal `apps/helper/package.json` version.
2. `bun install --frozen-lockfile`, typecheck, tests, plugin build, helper build for every target with
   `FONT_SYNC_PUBLIC_BUILD=1`, `codesign --verify --strict` on both darwin binaries, `--version` smoke
   test of darwin-arm64.
3. `bun apps/helper/scripts/pack-npm.ts` writes `apps/helper/dist/npm/<package>/`.
4. Publish with npm trusted publishing (`id-token: write`, Node 24, npm 11.5.1 or newer): every platform
   package first, skipping a version already on the registry, then the main package only if all of them
   succeeded. Trusted publishing adds npm provenance, since the GitHub repo is public.
5. Attach the binaries to a GitHub release.

A manual run (`workflow_dispatch` with `dry_run`) builds and packs without publishing.

One-time bootstrap: npm adds trusted publishers only to packages that exist, so the first release
publishes with a short-lived `NPM_TOKEN` repository secret (npm tries trusted publishing first and falls
back to it). Then the secret is deleted, and before the second release each package gets
`npm trust github <pkg> --file release.yml --repo Code-Parth/figma-font-sync --allow-publish -y`. See
`docs/releasing.md`.
