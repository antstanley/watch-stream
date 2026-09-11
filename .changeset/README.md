# Changesets

`pnpm changeset` records an intent to release (patch/minor/major) with a summary.
The Version PR workflow folds pending changesets into one pull request; merging
it bumps `package.json`, writes `CHANGELOG.md`, and then a tag push hands over to
`release.yml` for staged publishing.

See [RELEASING.md](../RELEASING.md).
