# watch-tail

## 0.6.0

### Minor Changes

- [#15](https://github.com/antstanley/watch-stream/pull/15) [`d9ec39b`](https://github.com/antstanley/watch-stream/commit/d9ec39b66aedfa21798e8277525795ec473fe11a) Thanks [@antstanley](https://github.com/antstanley)! - Group the lines of a request into one row, in the log view and in the chart.

  A request id is read from each line - a declared `requestId` (also `request_id`, `awsRequestId`,
  `x-request-id`) or the `RequestId: ...` a Lambda prints - and the lines that share it become one row in
  the log view: the request id, how many lines it wrote, how long it took, and the level of its most
  critical line. Click the row to open every line, indented and in order.

  The chart counts one mark per request instead of one per line, placed where the request started and
  coloured by that same most critical level, so a spike of failing requests is a spike of marks rather
  than a spike of log volume. The archive answers that in one SQL statement, and a CloudWatch view
  buckets the requests it has already streamed.

  It is on by default and the log view's **By request** button turns it off, which the app remembers.
  Lines with no request id are never grouped, so nothing is hidden by an id the log did not have.

### Patch Changes

- [#15](https://github.com/antstanley/watch-stream/pull/15) [`d9ec39b`](https://github.com/antstanley/watch-stream/commit/d9ec39b66aedfa21798e8277525795ec473fe11a) Thanks [@antstanley](https://github.com/antstanley)! - Give the chart tooltip a background.

  layerchart draws its tooltip with colours that come from `--color-surface-*` variables, which only its
  framework presets (shadcn-svelte, Skeleton, daisyUI) define. This app imports none of them, so the
  tooltip rendered fully transparent with black text - unreadable over a dark chart. It now carries its
  own panel styling (dark background, border, light text, elevation shadow), and the browser smoke run
  checks the rendered colours so it cannot regress unnoticed.

- [#15](https://github.com/antstanley/watch-stream/pull/15) [`d9ec39b`](https://github.com/antstanley/watch-stream/commit/d9ec39b66aedfa21798e8277525795ec473fe11a) Thanks [@antstanley](https://github.com/antstanley)! - Make Ctrl+C stop the CLI while a prompt is open.

  Cancelling one of the CLI's questions (the login offer, the profile picker) was read as "No" - so
  Ctrl+C at that prompt looked like it did nothing, and the process carried on with its server still
  running. Worse, the question left the terminal in raw mode, where Ctrl+C no longer produces a signal at
  all, so every later attempt in that terminal was swallowed too.

  A cancelled prompt is now a stop: the CLI says `Cancelled.`, shuts the server down, prints `stopped`,
  exits like any other Ctrl+C, and hands the terminal back in its normal state. If a terminal was already
  left in raw mode by an earlier version, `stty sane` repairs it.

## 0.5.0

### Minor Changes

- [`820a176`](https://github.com/antstanley/watch-stream/commit/820a176f3b47c7c6dafdf726729ac4d526e32458) Thanks [@antstanley](https://github.com/antstanley)! - Keep a local DuckDB archive of everything you stream, and browse it without AWS

  Every event that arrives while a stream is open is now appended to a local DuckDB file
  (`~/Library/Application Support/watch-tail/archive.duckdb` on macOS, the equivalent data directory
  elsewhere). A new **Local archive** source in the UI lists the groups that file holds and replays any
  window from it - instantly, and with no credentials, so history still works with an expired SSO
  session or no AWS access at all. `--db <path>` moves the archive and `--no-archive` switches it off.

  - `GET /api/stream` and `GET /api/log-groups` take a `source` parameter: `cloudwatch` (default) or
    `archive`.
  - `GET /api/archive` reports the file, its size and its contents; it never fails, and reports why the
    archive is unavailable instead.
  - Archived events are de-duplicated by CloudWatch event id, or by a hash of timestamp, stream and
    message when an emulator omits ids, so re-scanning a window does not duplicate rows.
  - Every archived line stores its level (`error`, `warn`, `info`, `debug` or no level at all), taken
    from the level the payload declares when there is one and from the line otherwise. The viewer gains
    level chips to narrow to one severity, and the archive stream accepts a `level` filter.
  - The DuckDB driver is an optional dependency: without it the app behaves exactly as before and says
    so on startup.

- [#14](https://github.com/antstanley/watch-stream/pull/14) [`9529416`](https://github.com/antstanley/watch-stream/commit/95294160d1746d82d449e0d83ce53487d0779258) Thanks [@antstanley](https://github.com/antstanley)! - See the shape of an incident: a level-coloured scatter chart, brushing, and several groups at once

  A scatter chart now sits above the log view. X is time, Y is the number of events in a bucket, and
  every level gets its own colour, so a spike reads as errors or as noise before you scroll a single
  line. Drag across the chart to brush a range: the log view, the window chip and the URL all follow, so
  `?from=&to=` is a shareable view of that moment. A click clears the brush and **Reset zoom** returns to
  the preset window. The level chips filter the chart and the log view together, and the chart's legend
  splits the totals by level.

  The sidebar now takes more than one log group. Ticking extra groups streams them together, adds a
  group column to the view, covers all of them in the chart, and keeps the selection in the URL as
  `groups=a,b` (a single group still uses `group=a`, so older links keep working). The archive reads
  several groups in one SQL statement; CloudWatch runs one tail per group and merges them, so a quiet
  group never holds back a busy one.

  The brush zooms when the drag is released, not while the pointer is down, and a click or a slipped
  pointer clears the brush instead of zooming to a sliver of the window.

  The chart panel collapses to a single header line (totals and per-level counts) and remembers that
  choice, and the charting library is loaded on demand: the chart code is fetched in the browser only
  once the panel is open, so it never delays the log view's first paint (about 235 KiB of chart code
  after the page starts, and none at all while collapsed).

  `GET /api/series` is the chart's data: bucketed counts per group and level, with an automatic bucket
  width, an optional `bucket`, a `level` filter, and no 14-day clamp - the archive keeps what CloudWatch
  has forgotten. The chart is drawn with [layerchart](https://www.layerchart.com).

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
