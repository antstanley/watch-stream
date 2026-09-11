# Releasing

Publishing is **staged**: the workflow uploads to npm's staging area and a human
approves it before anyone can install it. There is no npm token in the
repository - authentication is GitHub OIDC trusted publishing.

## One-time setup

Do these once, before the first release.

1. **Two-factor authentication** on npm and GitHub, with a security key or an
   authenticator app.
2. **Trusted publisher** for the package on npm (`watch-tail`) or, before the
   package exists, from the CLI:

   ```bash
   npm trust github watch-tail --repo antstanley/watch-stream --file release.yml --allow-stage-publish
   ```

   The npm settings page equivalent is _Package → Settings → Trusted Publishing_:
   repository `antstanley/watch-stream`, workflow `release.yml`, with
   "Allow npm stage publish" checked.

3. **Require 2FA and disallow tokens** for publishing:

   ```bash
   npm access set mfa=publish watch-tail
   ```

4. **GitHub environment `publish`** (Settings → Environments) with a required
   reviewer, limited to the `main` branch, and no admin bypass. The release
   workflow names this environment, so publishing waits for that approval.
5. **Repository security** (Settings → Actions → General): require actions to be
   pinned to a full-length commit SHA, require approval for first-time
   contributors, and set the default workflow token to read-only. Protect `main`
   with a pull-request rule.
6. Optionally keep actions current with `npx actions-up` and lint workflows with
   `zizmor .github/workflows/release.yml`.

## Cutting a release

```bash
pnpm changeset                      # describe the change (patch/minor/major)
git add .changeset && git commit -m "Add changeset" && git push
```

The _Version PR_ workflow turns pending changesets into a "Release: version
packages" pull request. Merging it bumps `package.json` and writes
`CHANGELOG.md`. Then tag the merge commit:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`release.yml` then validates that the tag matches `package.json`, runs the full
gate, packs the tarball, and stages it:

```
npm stage publish --provenance --access public --ignore-scripts --tag latest watch-tail-0.1.0.tgz
```

Approve it to go live:

```bash
npm stage approve            # or the npmjs "Staged packages" page
```

Staged packages are visible at
<https://www.npmjs.com/settings/~/staged-packages>; the workflow writes the
staging id to the run summary.

## Prereleases

A tag with a suffix publishes under a prerelease dist-tag, so it never becomes
`latest`: `v0.2.0-beta.1` stages `watch-tail@0.2.0-beta.1` under `beta`.

## Local checks before tagging

```bash
pnpm verify            # types, tests, lint, format, knip, build
pnpm test:e2e          # floci integration (needs floci running)
pnpm test:cli          # the built CLI serves the UI
pnpm publish:check     # publint + the exact tarball contents
```

## Manual publishing (break glass)

Only if trusted publishing is unavailable. npm requires 2FA for this because of
`mfa=publish`:

```bash
pnpm build
npm publish --ignore-scripts --access public
```

Never commit an npm token, and never add one to this repository's secrets.
