# figma-font-sync

Font Sync shows every font a Figma file uses, tells you which ones are missing on your computer, and
installs them from your team's shared Google Drive folder. It is for teams that don't have Figma
Organization's shared fonts.

It comes in two parts. A Figma desktop plugin scans the open file. A small helper program on each
teammate's computer signs in to Google, reads the shared folder and installs fonts, because a Figma
plugin cannot write files to disk. Who can do what follows the sharing on the Drive folder. There is
no Font Sync server.

## Requirements

- The Figma desktop app on macOS 13 or newer, or Windows 10 version 1809 or newer. Development plugins
  don't run in Figma in a browser.
- Node.js 18 or newer for the npm install. The curl installer needs no Node.
- A Google account that can open your team's library folder, and the Google client ID and secret your
  team's admin created (see [Google Cloud setup](#google-cloud-setup)).
- Linux (x64, glibc) works only for the command line `sync`, since Figma has no Linux desktop app.

## Install

```bash
npm i -g figma-font-sync
```

Or, on macOS and Linux:

```bash
curl -fsSL https://unpkg.com/figma-font-sync/install.sh | sh
```

The script downloads the binary for your machine from the npm registry, checks npm's registry signature
and the checksum, copies it to `~/.local/bin` (no sudo) and runs `figma-font-sync setup`. Set
`FIGMA_FONT_SYNC_INSTALL_DIR` to install somewhere else. To skip setup:
`curl -fsSL https://unpkg.com/figma-font-sync/install.sh | sh -s -- --no-setup`.

Windows uses npm. If PowerShell refuses to run `figma-font-sync` because scripts are disabled, run
`figma-font-sync.cmd` instead, or use Command Prompt.

## Quick start

1. Run setup:

   ```bash
   figma-font-sync setup
   ```

   It asks for the Google client ID and secret, installs the plugin files, turns on start at login,
   starts the helper and offers to sign you in to Google. It ends by printing the path of the plugin's
   `manifest.json`.
2. In Figma desktop, open a design file and choose **Plugins > Development > Import plugin from
   manifest...**. Pick the `manifest.json` that setup printed. You only do this once, because updates keep
   the same path.
3. Run **Plugins > Development > Font Sync**.
4. Click **Pair**. A browser tab opens with a 6-digit code. Type it into the plugin.
5. Click **Sign in with Google** if setup didn't sign you in already. If one library folder is shared
   with you, the plugin selects it.

`figma-font-sync plugin` prints the manifest path again.

## Google Cloud setup

One person on the team does this once. Font Sync ships without a Google client, so each team creates
its own and everyone enters the same client ID and secret in `figma-font-sync setup`.

1. Create a project at <https://console.cloud.google.com>.
2. Open **APIs & Services > Library**, search for **Google Drive API** and click **Enable**.
3. Open **Google Auth Platform > Branding**. Enter an app name, which people see when they sign in, a
   user support email and a developer contact email. The app home page and privacy policy links are
   only needed if you publish the app (next step).
4. Open **Audience** and pick the user type.
   - **Internal** if everyone signs in with an account in one Google Workspace domain. Google doesn't
     review the app, shows no warning and sets no user limit. Accounts outside the domain can't sign in.
   - **External** for everyone else, for example personal Gmail accounts. The app starts in **Testing**.
     Add each teammate's Google account under **Test users** (100 at most). In Testing, sign-ins expire
     every 7 days, so everyone signs in again each week.

     To end the weekly sign-in, click **Publish app**. Publishing needs a home page and a privacy policy
     on a domain you own, entered under Branding. Google won't have verified the app, so each person sees
     *Google hasn't verified this app* the first time and clicks **Advanced**, then the *Go to ...
     (unsafe)* link. Google allows this for fewer than 100 users per project.
5. Open **Data access**, click **Add or remove scopes** and add
   `https://www.googleapis.com/auth/drive` (paste it under *Manually add scopes*).
6. Open **Clients**, click **Create client**, choose **Desktop app**, give it a name and click
   **Create**. Copy the client ID and the client secret. Google shows the secret only once, so download
   the JSON too if you want a copy.
7. Send both values to your teammates through a password manager or another private channel. They paste
   them when `figma-font-sync setup` asks, or run
   `figma-font-sync setup --client-id <id> --client-secret <secret>`.

**Why full Drive access.** Several people add fonts to the same folder. Google's narrower `drive.file`
scope only shows an app the files that the signed-in person created or opened with it, so nobody would
see fonts a teammate added, and sharing the folder doesn't change that. Full Drive access is a
restricted scope, which is why an External app shows the unverified-app warning. The helper uses it to
find folders named `font-sync-figma-plugin` and to read and write inside the one you use.

Google deletes OAuth clients that haven't been used for 6 months. If sign-in fails with
`deleted_client` or `invalid_client` after a long break, create a new client. Everyone then runs
`figma-font-sync setup --client-id <id> --client-secret <secret>`, which signs out of the old client
and offers to sign in with the new one. A helper that is already running switches to it without a
restart.

## Sharing the library

The library is a Google Drive folder named `font-sync-figma-plugin`.

1. One person, the owner, runs the plugin, signs in and clicks **Create library** (or runs
   `figma-font-sync library create`). The folder appears in the owner's My Drive.
2. The owner shares the folder in Google Drive with each teammate:

   | Drive access | In Font Sync |
   |---|---|
   | Owner | Everything, including removing any font |
   | Editor | Install, add fonts, remove fonts they added |
   | Viewer or Commenter | Install only |

3. Teammates sign in and the plugin finds the folder. Someone who can see more than one folder with
   that name picks one in the plugin, or runs `figma-font-sync library use <folder URL>`.

To stop editors from inviting other people, open the share dialog's settings and turn off *Editors can
change permissions and share*.

Only add fonts whose licences allow everyone the folder is shared with to use them.

## Using the plugin

On the **This file** tab, click **Scan**. Each font the file uses gets a status:

| Status | Meaning |
|---|---|
| Install | Missing in Figma, and the library has it |
| Not in library | Missing, and nobody has added it to the library |
| Add to library | Installed on your computer, not in the library yet, and you can upload |
| Synced | Available in Figma and in the library |
| Provided by Figma | Figma supplies it, for example Google Fonts or fonts uploaded to your Figma account |
| Reload tab | Installed, but Figma hasn't loaded it yet |
| Replace font | The library's closest match is installed under another name; switch the file to that name |
| Local only | Installed on your computer, not in the library, and you can't upload |

Click a font name to select the layers that use it.

The **Library** tab lists every font in the folder, with Install, Update and Uninstall. Editors can drop
.ttf, .otf, .ttc and .otc files there to upload them.

After installing, reload the file tab so Figma sees the new fonts: right-click the tab, choose
**Reload tab**, then scan again.

## Keeping the helper running

The plugin only works while the helper runs. `setup` turns on start at login (a LaunchAgent on macOS, a
Run registry entry on Windows, a systemd user unit on Linux), so it runs in the background with no
window.

Figma desktop can't start programs for a plugin, so the plugin can't launch the helper. When it can't
reach the helper, it shows the command to run with a copy button, and carries on as soon as the helper
answers.

```bash
figma-font-sync status     # running? signed in? paired?
figma-font-sync start      # start in the background; does nothing if it is already running
figma-font-sync stop       # with start at login on, it starts again at your next login
figma-font-sync restart
figma-font-sync doctor     # check everything and print a fix for each problem
```

## CLI reference

| Command | Does |
|---|---|
| `setup [--client-id <id>] [--client-secret <secret>] [--no-autostart] [--no-login] [--yes]` | Saves the Google client (asks unless you pass the flags), copies the helper to its data folder, writes the plugin files and prints the manifest path, turns on start at login, starts the helper and offers sign-in. Never prompts without a terminal |
| `start` | Refreshes the helper copy and plugin files, then starts the helper in the background. Leaves a running helper of the same version alone and replaces one of another version. Waits up to 10 s for it to answer |
| `stop` | Stops the helper |
| `restart` | `stop`, then `start` |
| `status` | Shows sign-in, library, start at login and paired plugins |
| `doctor` | One line per check (ok, warn or fail) with the fix. Exits 1 if a check fails |
| `plugin` | Writes the plugin files if they are missing or outdated, and prints the manifest path and import steps |
| `login`, `logout` | Signs in to or out of Google |
| `library list` | Lists the `font-sync-figma-plugin` folders you can see |
| `library use <folder>` | Uses a library folder, by id or Drive folder URL |
| `library create` | Creates a library folder in your My Drive and uses it |
| `sync [--dry-run]` | Installs every library font that is missing or outdated |
| `autostart enable`, `disable`, `status` | Turns start at login on or off, or shows it |
| `pairs list`, `pairs revoke-all` | Lists paired plugins, or unpairs all of them |
| `uninstall [--purge] [--yes]` | Stops the helper, turns off start at login and deletes the helper copy and plugin files. `--purge` also deletes settings, caches and the stored Google sign-in. Installed fonts stay |
| `serve` | Runs the helper in the foreground, and is the default with no command. Start at login runs this |
| `version`, `help` | Prints the version, or the list of commands |

| Environment variable | Effect |
|---|---|
| `FONT_SYNC_GOOGLE_CLIENT_ID`, `FONT_SYNC_GOOGLE_CLIENT_SECRET` | Google client to use instead of the one setup saved |
| `FONT_SYNC_PORT` | Port to listen on (default 47321). The plugin only talks to 47321 |
| `FONT_SYNC_NO_BROWSER=1` | Print links instead of opening a browser |
| `FIGMA_FONT_SYNC_BINARY` | Native binary for the npm launcher to run instead of the installed one |
| `FIGMA_FONT_SYNC_VERSION` | For install.sh: the version to install |
| `FIGMA_FONT_SYNC_INSTALL_DIR` | For install.sh: where to put the binary (default `~/.local/bin`) |

## Updating

```bash
npm i -g figma-font-sync@latest     # or run the curl line again
figma-font-sync restart
```

`restart` copies the new version to the data folder, rewrites the plugin files and starts it. The
manifest path doesn't change, so Figma keeps the plugin. Close and reopen the plugin to load the new
version.

## Uninstall

```bash
figma-font-sync uninstall        # --purge also deletes settings and your Google sign-in
npm rm -g figma-font-sync        # or delete ~/.local/bin/figma-font-sync after a curl install
```

Fonts that Font Sync installed stay installed. To remove them first, use **Uninstall** on the plugin's
Library tab. In Figma, remove the plugin under **Plugins > Development > Manage plugins in
development**.

## Privacy

- Your Google sign-in stays on your computer, in the OS keychain: Keychain on macOS, Credential Manager
  on Windows, the Secret Service on Linux. Without a Secret Service it goes to a file only you can read.
  The plugin never sees it and holds only a pairing token.
- The helper talks to Google, for sign-in and the Drive API, and to the Figma plugin on this computer
  through `localhost:47321`. It doesn't accept connections from other computers.
- No telemetry, and no Font Sync server.

## Platform notes

| | macOS | Windows | Linux |
|---|---|---|---|
| Plugin manifest | `~/Library/Application Support/font-sync/figma-plugin/manifest.json` | `%LOCALAPPDATA%\font-sync\figma-plugin\manifest.json` | none, no Figma desktop |
| Installed fonts | `~/Library/Fonts` | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` | `~/.local/share/fonts/font-sync` |
| Log when started at login | `~/Library/Logs/font-sync.log` | `%LOCALAPPDATA%\font-sync\font-sync.log` | `journalctl --user -u font-sync` |

- Without start at login, `start` logs to `font-sync.log` in `~/Library/Application Support/font-sync`
  on macOS and `~/.local/state/font-sync` on Linux.
- Windows installs fonts for the current user, so no admin rights are needed. If Figma still doesn't
  list a font after you reload the tab, install that file "for all users" by hand. Some Windows setups
  only pick fonts up from there.
- On Linux, `figma-font-sync sync` installs the whole library. Browser Figma needs
  [figma-agent-linux](https://github.com/neetly/figma-agent-linux) to see local fonts.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The plugin says the helper isn't running | Run `figma-font-sync start`. If it keeps stopping, run `figma-font-sync doctor` and read the log (Platform notes) |
| `command not found` after the curl install | Add `~/.local/bin` to your PATH with the line the installer printed, then open a new terminal |
| The launcher says the platform package is missing | npm skipped optional dependencies. Run `npm i -g figma-font-sync` again without `--omit=optional` |
| PowerShell says running scripts is disabled | Run `figma-font-sync.cmd`, or use Command Prompt |
| `Port 47321 is busy` | A helper is already running. `figma-font-sync status`, or `figma-font-sync restart` |
| `status` says Google is not configured | Run `figma-font-sync setup` and enter the client ID and secret |
| *Access blocked: ... can only be used within its organization* | The app is Internal and your account is outside that Workspace. Sign in with your work account, or ask the admin to switch to External |
| *Access blocked: ... has not completed the Google verification process* | The app is External, in Testing, and you aren't a test user. Ask the admin to add you |
| *Google hasn't verified this app* | Expected for a published External app. Click **Advanced**, then the *Go to ... (unsafe)* link |
| Asked to sign in again every week | The app is in Testing. The admin can publish it (Google Cloud setup, step 4) |
| The plugin asks to pair again | The pairing was revoked or Figma's plugin storage was cleared. Pair again |
| Installed, but Figma still shows the font as missing | Reload the file tab. On Windows, see Platform notes |
| Figma can't find the plugin's files | Run `figma-font-sync plugin`, then import the manifest path it prints |

## Licence

Source-available, not open source. You may install and use Font Sync unmodified, for personal or
internal business purposes. You may not modify, redistribute or sell it. The full terms are in the
LICENSE file in this package.

Maintainers: `CLAUDE.md`, `docs/distribution.md` and `docs/releasing.md` in the source repository.
