# Releasing

How to publish `figma-font-sync` to npm. What the packages contain and why: `docs/distribution.md`.

## Versioning

- One number for everything: `version` in `apps/helper/package.json`. The binary's `version` output, the
  main package, the four platform packages, the main package's exact `optionalDependencies` pins, the
  launcher's version check and the version baked into `install.sh` all come from it.
- `apps/helper/openapi.json` carries it too, so run `bun run gen` after a bump and commit both. CI fails
  when `openapi.json` is stale.
- The release tag is `v` plus that version, for example `v0.2.0`. The workflow refuses a tag that doesn't
  match.
- Semver: patch for fixes, minor for features, major when users have to do something after updating
  (import the plugin again, sign in again, a new Google scope).

## One-time bootstrap

npm only lets you add a trusted publisher to a package that already exists. So the first release
publishes with a short-lived token, and every later release uses trusted publishing with no token.

1. Use an npm account with two-factor authentication turned on.
2. Create the npm organisation `figma-font-sync` on npmjs.com (**Add Organization**, free plan, which
   allows public packages). Only org members can publish `@figma-font-sync/*`, so nobody can squat a
   platform package name the main package lists.
3. Create a granular access token on npmjs.com (avatar > **Access Tokens** > **Generate New Token** >
   **Granular Access Token**): expiration 7 days, **Bypass two-factor authentication** on (the workflow
   cannot answer a 2FA prompt), **Packages and scopes**: Read and write, **All packages** (the unscoped
   `figma-font-sync` does not exist yet, so it cannot be selected by name).
4. Store it as a repository secret. `gh` asks for the value, so it never lands in your shell history:

   ```bash
   gh secret set NPM_TOKEN --repo Code-Parth/figma-font-sync
   ```

5. Release as in **Normal release** below. The workflow uploads all five packages with the token and
   creates the GitHub release.
6. Approve the uploads. npm stages a publish made with a token that bypasses 2FA instead of making it
   live: until a maintainer approves it with 2FA, a new package shows only a public placeholder version,
   `0.0.0-stage`. Approve the four platform packages first and `figma-font-sync` last, either on
   npmjs.com (**Staged Packages** tab > **Approve**) or with npm 11.15.0 or newer:

   ```bash
   npm stage list
   npm stage approve <stage-id>
   ```

   The registry can keep answering "not found" for a few minutes after approval; query with
   `npm view <pkg> --prefer-online` before assuming something is missing.
7. Remove the token as soon as the release is out:

   ```bash
   gh secret delete NPM_TOKEN --repo Code-Parth/figma-font-sync
   ```

   and delete it on npmjs.com (**Access Tokens**).
8. Right before the second release, add the GitHub Actions trusted publisher to each package. A new
   trusted publisher has to publish within 2 days or npm drops it, so do this when the next tag is ready,
   not straight after the first release. It needs npm 11.15.0 or newer and `npm login`. npm 12 needs
   Node 24.15 or newer; on an older Node, `npm i -g npm@11` gets the latest npm 11, which is enough:

   ```bash
   for pkg in @figma-font-sync/darwin-arm64 @figma-font-sync/darwin-x64 \
              @figma-font-sync/windows-x64 @figma-font-sync/linux-x64 figma-font-sync; do
     npm trust github "$pkg" --file release.yml --repo Code-Parth/figma-font-sync --allow-publish -y
     sleep 2
   done
   ```

   The fields are case-sensitive and npm only checks them when the workflow publishes.
9. Optional: deprecate the placeholders so nobody installs them by accident (asks for 2FA):

   ```bash
   for pkg in @figma-font-sync/darwin-arm64 @figma-font-sync/darwin-x64 \
              @figma-font-sync/windows-x64 @figma-font-sync/linux-x64 figma-font-sync; do
     npm deprecate "$pkg@0.0.0-stage" "Staged-publishing placeholder. Install the latest version."
   done
   ```

10. Optional, once trusted publishing has published a release: in each package's settings on
    npmjs.com, set publishing access to require two-factor authentication and disallow tokens.

## Normal release

1. On a branch, bump `version` in `apps/helper/package.json`, run `bun run gen`, and in `CHANGELOG.md`
   move the `Unreleased` entries under a new `## [X.Y.Z] - YYYY-MM-DD` heading and add its compare link
   at the bottom. Commit `package.json`, `openapi.json` and `CHANGELOG.md`, and merge once CI passes.
2. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. `.github/workflows/release.yml` runs on the tag, on a GitHub-hosted macOS arm64 runner. It checks the
   tag against the version, typechecks, tests, builds the plugin and every binary with
   `FONT_SYNC_PUBLIC_BUILD=1`, verifies both darwin signatures, smoke-tests `--version`, and packs.
4. It publishes the four platform packages first, skipping any version already on the registry, and the
   main package only if all four succeeded. Then it attaches the binaries to a GitHub release.

If a run fails halfway, fix the cause and re-run it: platform packages that made it are skipped. If the
fix needs a code change, release the next patch instead, since a published version can't be replaced.

To test the workflow without publishing, run it by hand with `dry_run` (**Actions > Release > Run
workflow**, or `gh workflow run release.yml -f dry_run=true`). It builds and packs, and publishes
nothing.

## Provenance

The repository is public, so releases published through trusted publishing get npm provenance on their
own: no flag in the workflow or the package files. Token-published versions have none; 0.1.0 is one.
Each package's `repository.url` names `Code-Parth/figma-font-sync`, which trusted publishing requires.

## Never ship a Google client

- A public build never contains `FONT_SYNC_GOOGLE_CLIENT_ID` or `FONT_SYNC_GOOGLE_CLIENT_SECRET`. Anyone
  can download an npm package and read the strings in its binary, and each team is meant to bring its
  own client through `figma-font-sync setup`.
- The release workflow always sets `FONT_SYNC_PUBLIC_BUILD=1`, which fails the build if either variable
  is set. Don't add them as repository or environment secrets.
- A private build for one team, with its client baked in, is
  `FONT_SYNC_GOOGLE_CLIENT_ID=... FONT_SYNC_GOOGLE_CLIENT_SECRET=... bun run build`. It stays inside that
  team and is never published. The env and `config.json` still take precedence over the baked-in client.

## Verifying a release

```bash
npm view figma-font-sync version
npm view figma-font-sync@0.2.0 optionalDependencies     # every entry must say 0.2.0
```

Install it into scratch locations, away from your real install:

```bash
tmp=$(mktemp -d)
npm i -g --prefix "$tmp/npm" figma-font-sync@0.2.0
"$tmp/npm/bin/figma-font-sync" version

curl -fsSL https://unpkg.com/figma-font-sync@0.2.0/install.sh \
  | FIGMA_FONT_SYNC_INSTALL_DIR="$tmp/curl" sh -s -- --no-setup
"$tmp/curl/figma-font-sync" version
```

The exact-version unpkg URL avoids its 5-minute cache of `latest`. The installer checks npm's registry
signature with a pinned key and then the sha512, so a clean run means npm signed what it installed.

Then update your own machine the way users do, and use the plugin in Figma desktop (scan a file,
install a font):

```bash
npm i -g figma-font-sync@latest
figma-font-sync restart
figma-font-sync doctor        # no "fail" lines
```

Never smoke-test with `figma-font-sync uninstall --purge` or `logout`. The Google sign-in lives in the
real OS keychain, and a temporary `HOME` does not isolate it.

## Rolling back

A published version can't be replaced. In order of preference:

1. Deprecate it, so npm warns everyone who installs it:

   ```bash
   npm deprecate figma-font-sync@0.2.0 "Broken on Windows; use 0.2.1"
   ```

2. Point `latest` back at the last good version. The main package pins exact platform versions, so its
   tag is the only one that matters, and the unpkg `install.sh` URL follows within about 5 minutes:

   ```bash
   npm dist-tag add figma-font-sync@0.1.3 latest
   ```

   People who already updated go back with `npm i -g figma-font-sync@0.1.3` and
   `figma-font-sync restart`. `start` replaces a helper of any other version, older or newer, and rewrites
   the plugin files whenever their version differs.
3. Publish a fixed patch through the normal release. It becomes `latest`.
4. Unpublish only as a last resort. npm allows it within 72 hours of publishing when nothing else depends
   on the package, and later only under narrow conditions. The version number can never be reused. The
   main package depends on every platform package, which can block unpublishing them, and unpublishing a
   platform version breaks every main version that pins it.
