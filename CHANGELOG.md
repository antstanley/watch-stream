# watch-tail

## 0.3.0

### Minor Changes

- [#5](https://github.com/antstanley/watch-stream/pull/5) [`3fa9cf0`](https://github.com/antstanley/watch-stream/commit/3fa9cf06335dea11cd936fe317f18f703e408393) Thanks [@antstanley](https://github.com/antstanley)! - Detect unusable AWS credentials at startup, and offer the login that fixes them.

  The CLI now asks the running app for one log group before opening the browser. If
  AWS refuses because of credentials, it reads how the profile is configured and
  offers the matching command: `aws sso login --profile X` for SSO profiles,
  `aws login --profile X` for console sign-in profiles (or one with nothing
  configured yet), and no login at all for static keys or a `credential_process`,
  where the fix is elsewhere. The login runs with the terminal attached, so the
  browser flow works; `--remote` is added on headless hosts. Decline, and it prints
  the command instead and leaves the app running. Emulator runs skip the check.

## 0.2.1

### Patch Changes

- [#3](https://github.com/antstanley/watch-stream/pull/3) [`5916b69`](https://github.com/antstanley/watch-stream/commit/5916b694c9574c55f656ea35804463a4305c0331) Thanks [@antstanley](https://github.com/antstanley)! - Make shell completions complete the values that matter.

  `--profile` now offers the profiles from your own AWS config instead of just
  `default`, `--region` offers the CloudWatch Logs region list, `--open` is
  completable, and the stray `presets` pseudo-command is gone. The completion
  protocol is covered by tests, including a generated script for each supported
  shell.

## 0.2.0

### Minor Changes

- [#1](https://github.com/antstanley/watch-stream/pull/1) [`bc807a3`](https://github.com/antstanley/watch-stream/commit/bc807a38bbfc4aae92252a3e0871a8a41de556bd) Thanks [@antstanley](https://github.com/antstanley)! - Add a `wt` shorthand for the CLI.

  Installing the package globally now provides `wt` alongside `watch-tail`, so the
  common case is three characters: `wt --profile my-profile`. Both names run the
  same binary.

## 0.1.0

### Minor Changes

- [`17766f5`](https://github.com/antstanley/watch-stream/commit/17766f594f6c7135bf53ec895e3f3acc04ce4faf) Thanks [@antstanley](https://github.com/antstanley)! - First public release of `watch-tail`.

  `npx watch-tail` starts a local UI for Amazon CloudWatch Logs and streams a log
  group into your browser: region and group pickers, live tailing over SSE, historic
  scans (15m/1h/3h/12h/24h/5d or a custom window), JSON pretty-printing, resizable
  columns, and ambient AWS credentials throughout. It runs against real AWS, or
  against the floci emulator with `--floci`.
