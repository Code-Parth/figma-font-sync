# Font Sync

A Figma plugin that shows every font a file uses, which ones are missing on your machine, and installs
them from your team's shared Google Drive folder. It is built for people on individual Figma plans,
who don't get Figma's organization-wide shared fonts.

It has two parts:

- **The Figma plugin** scans the open file and shows the status of each font.
- **The Font Sync helper** is a small program that runs on each teammate's machine. It signs in to
  Google, reads the shared Drive folder, and installs fonts. A Figma plugin can't write files to disk,
  so this part has to exist.

Access is controlled by sharing the Drive folder `font-sync-figma-plugin`. Nobody hosts a server.

| Drive access on the folder | In the plugin |
|---|---|
| Owner | Everything, including removing any font |
| Editor | Install, add fonts, remove fonts they uploaded |
| Viewer / Commenter | Install only |

Design notes and the research behind them: [docs/architecture.md](docs/architecture.md).

## One-time setup (admin)

### 1. Google Cloud OAuth client

1. Create a project at <https://console.cloud.google.com> and enable the **Google Drive API**.
2. Go to **Google Auth Platform**:
   - **Audience**: if the whole team is in one Google Workspace domain, choose **Internal**. Otherwise
     choose **External** and click **Publish app** so the status is **In production**. Do not leave it in
     *Testing*: in Testing, Google expires sign-ins every 7 days.
   - **Data access**: add the scope `https://www.googleapis.com/auth/drive`.
3. Go to **Clients**, then **Create client**, then choose type **Desktop app**. Copy the client ID and
   secret. Google shows the secret only once.

The helper needs full Drive access because it has to read fonts that other people put in the shared
folder. Google's narrower `drive.file` scope can only see files the same person added through the app.

On an External app that Google hasn't reviewed, each person sees *Google hasn't verified this app*
the first time they sign in. Click **Advanced**, then **Go to Font Sync**. Google allows this for
fewer than 100 users.

### 2. Build

```bash
bun install
FONT_SYNC_GOOGLE_CLIENT_ID=... FONT_SYNC_GOOGLE_CLIENT_SECRET=... bun run build
```

`apps/helper/dist/` then contains one helper binary per platform with the client baked in, plus a
`figma-plugin/` folder. Keep these builds inside the team.

Requires Bun 1.4.1 or newer for macOS binaries. On 1.4.0 the build script re-signs them as a workaround.

### 3. Create the library

Set up the helper and plugin on your own machine (next section), sign in, and choose **Create library**.
Then open the folder in Google Drive, click **Share**, and add each teammate as **Editor** or **Viewer**.
To stop editors from inviting other people, open the share dialog's settings and turn off
*Editors can change permissions and share*.

## Setup for each teammate

1. **Install the helper** for your OS from `apps/helper/dist/`. Rename it to `font-sync` (`font-sync.exe`
   on Windows) and put it somewhere on your PATH. On Windows, also put `font-sync-windows-x64-background.exe`
   in the same folder, renamed to `font-sync-background.exe`: start-at-login runs that copy, which has no
   console window and logs to `%LOCALAPPDATA%\font-sync\font-sync.log`.
   - macOS, if the file came through a browser: `xattr -d com.apple.quarantine font-sync`
   - Windows SmartScreen may warn about an unsigned program. Choose *More info*, then *Run anyway*.
2. **Start it at login**:

   ```bash
   font-sync autostart enable
   ```

   Or run `font-sync serve` in a terminal when you need it.
3. **Add the plugin in the Figma desktop app**: open *Plugins*, then *Development*, then
   *Import plugin from manifest…*, and pick `figma-plugin/manifest.json`. Development plugins only run
   in the desktop app.
4. **Run the plugin**: click **Pair**. A browser tab opens with a 6-digit code; type it into the plugin.
   Then click **Sign in with Google**. If the library folder has been shared with you, the plugin selects
   it automatically.

## Using it

- **This file**: click **Scan**. Each font gets one of these statuses:
  - **Install**: missing in Figma, and the library has it.
  - **Not in library**: missing, and nobody has added it yet.
  - **Add to library**: you have it installed, the library doesn't, and you can upload.
  - **Synced**: available and in the library.
  - **Provided by Figma**: Google Fonts and fonts uploaded to your Figma account.

  Click a font name to select the layers that use it.
- **Library**: every font in the Drive folder, with Install, Update and Uninstall. Editors can drop
  .ttf/.otf/.ttc/.otc files to upload them.
- **After installing**, Figma usually needs the file tab reloaded before it sees the new fonts.
  Right-click the tab, choose **Reload tab**, then scan again.

### CLI

```text
font-sync serve                        run the helper (default command)
font-sync login | logout | status
font-sync library list | use <folder id or Drive URL> | create
font-sync sync [--dry-run]             install every library font you don't have yet
font-sync autostart enable | disable | status
font-sync pairs list | revoke-all      paired plugin installs
```

## Platform notes

- **macOS**: fonts go to `~/Library/Fonts`.
- **Windows**: fonts are installed for the current user, so no admin rights are needed:
  `%LOCALAPPDATA%\Microsoft\Windows\Fonts` plus a registry entry. If Figma still doesn't list a font after
  you reload the tab, install that file "for all users" by hand. Some Windows setups only pick fonts up
  from there.
- **Linux**: fonts go to `~/.local/share/fonts/font-sync`. Figma has no official Linux desktop app, so the
  plugin can't run there. Use `font-sync sync` to install the whole library, plus
  [figma-agent-linux](https://github.com/neetly/figma-agent-linux) so browser Figma can see local fonts.

## Licences

Only add fonts to the library if their licences allow everyone the folder is shared with to use them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Plugin says the helper isn't running | Run `font-sync serve`, or `font-sync autostart status` |
| `Port 47321 is busy` | Another helper is already running; `font-sync status` |
| Plugin asks to pair again | The pairing was revoked or the plugin's storage was cleared. Pair again |
| *Sign in again* after a week | The OAuth app is in Testing. Publish it to production (setup step 1) |
| Installed, but Figma still shows it missing | Reload the file tab. On Windows, see the platform notes |

## Development

See [CLAUDE.md](CLAUDE.md) for the layout, invariants and commands.
