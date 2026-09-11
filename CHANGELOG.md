# watch-tail

## 0.4.0

### Minor Changes

- [#11](https://github.com/antstanley/watch-stream/pull/11) [`74ee9c3`](https://github.com/antstanley/watch-stream/commit/74ee9c361d8b2d6e0f3ea38469064d74f90a6116) Thanks [@antstanley](https://github.com/antstanley)! - Open a single log line's JSON on click, and give the app its own icon.

  With pretty-printing switched off, a line that carries JSON shows a marker and
  opens on click: the raw line stays where it is and the payload appears beneath
  it, indented and coloured - including for the "prefix then payload" lines
  CloudWatch often receives. Clicking again, or pressing Enter, closes it. Lines
  without JSON are not controls, so nothing pretends to be clickable.

  The stock framework icon is replaced with one of our own: a log window with the
  newest line highlighted.

- [#12](https://github.com/antstanley/watch-stream/pull/12) [`5214ef5`](https://github.com/antstanley/watch-stream/commit/5214ef52336a0b91d4495113349becc0aaac2f90) Thanks [@antstanley](https://github.com/antstanley)! - Check a chosen profile with STS before offering to log it in.

  Picking a profile no longer assumes it needs a login: the CLI restarts with it and
  asks `sts:GetCallerIdentity` about _that_ profile, so a profile whose SSO session
  is still cached is simply used - "profile beyond-mzansi already works
  (AWSReservedSSO_AWSAdministratorAccess) - using it" - instead of prompting for a
  login anyone would have to cancel. A login is offered only when the chosen
  profile genuinely has nothing usable, and after a successful login the result is
  confirmed with STS and reported by role name.

  Adds `GET /api/identity`, which returns the caller identity for the resolved
  configuration (arn, account, userId, region, endpoint) using the same credentials
  and endpoint resolution as the log routes.

### Patch Changes

- [#9](https://github.com/antstanley/watch-stream/pull/9) [`7bdd21f`](https://github.com/antstanley/watch-stream/commit/7bdd21f6dcd52e498736c5d7ea2dcd2a1c1ef255) Thanks [@antstanley](https://github.com/antstanley)! - Ask which AWS profile to use when credentials fail, and keep prompts working with NO_COLOR set.

  With several profiles configured, a credential failure assumed the ambient default
  and offered to log in there - rarely the account someone meant. The CLI now asks
  which profile to use (a searchable list; skipped when `--profile` or `AWS_PROFILE`
  already answers it, or when only one profile exists), runs the matching login for
  it, and restarts the app with that profile and its own region so the browser lands
  on a working session. Declining still leaves the app running as the chosen profile,
  with the exact command to run.

  `NO_COLOR` no longer disables prompts. It asks for no colour, and reading it as
  "do not prompt" silently skipped the profile and login questions for anyone who
  sets it.

## 0.3.1

### Patch Changes

- [#7](https://github.com/antstanley/watch-stream/pull/7) [`1f7a31a`](https://github.com/antstanley/watch-stream/commit/1f7a31a0b6769e19a6f1a222714b89ea860af6c0) Thanks [@antstanley](https://github.com/antstanley)! - Stop a development `.env.local` from silently redirecting the CLI at the emulator.

  Running `watch-tail` inside a checkout that has a `.env.local` (written by
  `pnpm floci:env` for the dev server) pointed the whole UI at floci instead of
  real AWS. The CLI now suppresses the emulator settings it finds in that file,
  prints which keys it ignored, and tells you `--floci` is the way to use them.
  Values you export yourself still win, and `--floci` still targets the emulator.

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
