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

npm only lets you add a trusted publisher to a package that already exists, so the first version of each
of the five packages goes up by hand, from a Mac (the build re-signs the darwin binaries with `codesign`).

1. Use an npm account with two-factor authentication turned on for sign-in and writes, and `npm login`.
2. Create the npm organisation `figma-font-sync` on npmjs.com (**Add Organization**, free plan, which
   allows public packages). Only org members can publish `@figma-font-sync/*`, so nobody can squat a
   platform package name the main package lists.
3. Build without a Google client:

   ```bash
   bun install --frozen-lockfile
   bun run gen
   bun run --cwd apps/plugin build
   FONT_SYNC_PUBLIC_BUILD=1 bun --no-env-file apps/helper/scripts/build.ts
   bun apps/helper/scripts/pack-npm.ts
   ```

   Bun loads `apps/helper/.env` into any script run from `apps/helper`, which would put your local
   Google client into the build. Running from the repo root with `--no-env-file` keeps it out, and
   `FONT_SYNC_PUBLIC_BUILD=1` fails the build if `FONT_SYNC_GOOGLE_CLIENT_ID` or `_SECRET` gets through
   anyway, for example from your shell.
4. Check what you are about to publish:

   ```bash
   apps/helper/dist/figma-font-sync-darwin-arm64 version
   codesign --verify --strict apps/helper/dist/figma-font-sync-darwin-arm64
   codesign --verify --strict apps/helper/dist/figma-font-sync-darwin-x64
   # Must print 0 for every binary: no client ID, no client secret.
   grep -acE 'GOCSPX-[A-Za-z0-9_-]{20,}|[0-9]{6,}-[a-z0-9]{32}\.apps\.googleusercontent\.com' \
     apps/helper/dist/figma-font-sync-*
   ```

   `pack-npm.ts` already refuses a binary that matches this pattern; the grep is the second check.

5. Publish the four platform packages, then the main package. `pack-npm.ts` wrote one directory per
   package under `apps/helper/dist/npm/`:

   ```bash
   for dir in darwin-arm64 darwin-x64 windows-x64 linux-x64 figma-font-sync; do
     (cd "apps/helper/dist/npm/$dir" && npm publish --access public) || break
   done
   ```

   npm asks for a 2FA code each time. The main package goes last because its `optionalDependencies`
   name the other four at this exact version.
6. Add the GitHub Actions trusted publisher to each package. This needs npm 11.15.0 or newer
   (`npm --version`; `npm i -g npm@latest` if older):

   ```bash
   for pkg in @figma-font-sync/darwin-arm64 @figma-font-sync/darwin-x64 \
              @figma-font-sync/windows-x64 @figma-font-sync/linux-x64 figma-font-sync; do
     npm trust github "$pkg" --file release.yml --repo Code-Parth/figma-font-sync --allow-publish -y
     sleep 2
   done
   ```

   The fields are case-sensitive and npm only checks them when the workflow publishes.
7. A new trusted publisher has to publish within 2 days or npm drops it. Cut the next release (a patch
   is fine) through the workflow straight away. If it lapses, repeat step 6.
8. Optional, once the workflow has published: in each package's settings on npmjs.com, set publishing
   access to require two-factor authentication and disallow tokens. Trusted publishing keeps working.

## Normal release

1. On a branch, bump `version` in `apps/helper/package.json`, run `bun run gen`, and commit
   `package.json` and `openapi.json`. Merge it once CI passes.
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

## No provenance

npm generates no provenance for packages published from a private GitHub repository, even with
trusted publishing, so neither the workflow nor the package files ask for it. If the repository becomes
public, npm's docs say trusted publishing adds provenance on its own.

Each package's `repository.url` names `Code-Parth/figma-font-sync`, as trusted publishing requires, so the
repository's name is public even though its contents are not.

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
