<div align="center">

# watch-tail

**Your CloudWatch logs, in a real window, in one command.**

`npx watch-tail` starts a local UI, lists the log groups in your AWS account, and streams whichever one
you pick - live, or across any historic window. No config file, no credentials to paste, no browser
tab fighting the AWS console.

[![npm version](https://img.shields.io/npm/v/watch-tail?color=blue)](https://www.npmjs.com/package/watch-tail)
[![CI](https://github.com/antstanley/watch-stream/actions/workflows/ci.yml/badge.svg)](https://github.com/antstanley/watch-stream/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/watch-tail)](./LICENSE)
[![node](https://img.shields.io/node/v/watch-tail)](package.json)

<img src="./docs/screenshot.png" alt="watch-tail streaming CloudWatch Logs" width="900">

</div>

```bash
npx watch-tail                                              # uses your ambient AWS credentials
npx watch-tail --profile my-profile --region af-south-1      # or a specific profile and region
npx watch-tail --floci                                      # or a local emulator, no AWS account
```

## Why watch-tail?

Because the two things you have today are the AWS console and `aws logs tail`, and both make you
work for every line.

- **The console is a form-filling exercise.** Region dropdown, log-group dropdown, sometimes a stream
  dropdown, then a text-only event viewer that forgets where you were. `watch-tail` opens on your
  region, lists every group with its size, and starts streaming the moment you click one.
- **`aws logs tail` is a wall of text.** `watch-tail` gives you pause with buffering, client-side
  filtering, clear, auto-scroll, a 5 000-line ring buffer, and a stream-name column that is truncated
  with the full value on hover - so a 95-character Lambda stream name cannot push your message off
  screen.
- **Logs arrive as payloads, not prose.** JSON entries are pretty-printed with syntax colouring by
  default, and one toggle shows the raw line when you need the wire format. With that toggle off,
  **click a line that carries JSON** and just that payload opens beneath it - indented, coloured, and
  without losing the raw line - and clicking again closes it.
- **"What happened an hour ago?" is the normal question.** Flip to **Historic** and scan 15 min, 1 h,
  3 h, 12 h, 24 h, 5 days - or pick a custom `from`/`to` window. The scan finishes on its own and the
  window lives in the URL, so `…&mode=historic&range=24h` is a shareable view of an incident.
- **Your credentials never move.** No keys to paste into a SaaS, no CLI to install into your CI, no
  vendor account: it uses the ambient AWS profile you already use, needs only two read-only IAM
  actions, and binds to loopback. Throwaway keys are used for a local emulator and only there.
- **It is one command and it goes away.** `npx watch-tail`, Ctrl+C. Nothing is deployed, nothing is
  sent anywhere, and there is no agent, sidecar or daemon to clean up.
- **You keep what you have seen.** Logs you stream are appended to a local DuckDB file, so the incident
  you looked at last week is still there - no re-scanning AWS, no 14-day cliff, no credentials needed
  to read it back. Switch the source to **Local archive** in the UI and the same window controls work
  against that file.

Use it when you are debugging a Lambda, chasing an API Gateway 5xx, watching a worker drain a queue,
or handing a teammate a link that shows exactly the window you are staring at.

## What you get

- **Region-first UI** - pick a region, see its log groups (with stored size), click one to stream.
- **Live and historic** - follow new events over SSE, or scan a fixed window up to the 14 days
  CloudWatch Logs keeps.
- **A log window built for real logs** - horizontal scrolling or wrapping, JSON pretty-printing with
  click-to-open payloads, drag-resizable stream-name column and group-list pane, level colouring,
  pause/clear/auto-scroll.
- **Shareable views** - region, group, mode and window all live in the URL.
- **Local emulation friendly** - `--floci` points at [floci](https://floci.io) on port 4566 for
  development without an AWS account.
- **History that outlives the window** - everything you stream is archived to a local
  [DuckDB](https://duckdb.org) file, so you can come back to it later - after the 14-day CloudWatch
  limit, with no AWS credentials at all - and query it with plain SQL.
- **See the shape of an incident before you read it.** A scatter chart above the log view plots events
  over time, coloured by level, so a spike is visible in one glance. Drag across it to zoom into that
  moment - the log view follows the brush, and a click clears it.
- **Follow more than one group at once.** Tick extra groups in the sidebar and the chart and the log
  view cover all of them, with a group column and a merged stream; the selection lives in the URL.
- **One request, one row.** Lines that share a request id are grouped - in the log view and in the
  chart - and coloured by the most critical line in the request, so you read requests instead of the
  twenty lines each one wrote. Toggle it off to see every line.
- **Severity you can filter on.** Every archived line is tagged `error`, `warn`, `info` or `debug`,
  and the viewer has chips to narrow to one level. A level the log itself declares
  (`{"level":"error"}`) is trusted; otherwise it is read from the line, and a line that carries no
  level at all stays unclassified instead of being called `info`.

## Install

```bash
npx watch-tail              # no install
pnpm add -g watch-tail      # or install once; `wt` is installed as a shorthand
```

Installed globally, the command is available as both `watch-tail` and the shorter `wt`:

```bash
wt --profile my-profile --region af-south-1
```

Requires Node 22 or newer (developed and tested on Node 24).

## CLI

```
watch-tail [options]

  -p, --profile <name>   AWS profile to use (default: ambient credentials)
  -r, --region <code>    Region to open on (default: profile region, else AWS_REGION)
      --endpoint <url>   Point the app at a local emulator instead of AWS
      --floci            Shorthand for --endpoint http://localhost:4566
      --port <number>    Port for the local UI (default 4517)
      --host <address>   Interface to bind (default 127.0.0.1, loopback only)
      --no-open          Do not open a browser window
      --print            Print the environment that would be used, then exit
      --list             List the AWS profiles found on disk, then exit
      --verbose          Log the server's own output
      --db <path>        Database file for local history (default: app data dir)
      --no-archive       Do not keep a local history archive
  -h, --help             Show this help
  -v, --version          Show the version
```

The CLI keeps the terminal while it runs: `Ctrl+C` stops the server and exits, whether it is idle or
waiting at one of its questions (the login offer, the profile picker) - cancelling a question is a stop,
not a "no".

Shell completions come from [`@bomb.sh/tab`](https://bomb.sh): flags, `--region` values from the
CloudWatch Logs region list, and `--profile` values from your own `~/.aws/config`. zsh, bash, fish and
powershell are supported.

```bash
source <(watch-tail complete zsh)                       # this shell, now
watch-tail complete zsh > ~/.watch-tail-completion.zsh  # or install it permanently
echo 'source ~/.watch-tail-completion.zsh' >> ~/.zshrc
```

The generated script re-invokes `watch-tail complete -- <words>`, so completions keep working after
you upgrade. Install the [`@bomb.sh/tab`](https://www.npmjs.com/package/@bomb.sh/tab) CLI globally if
you also want completions for a locally installed copy through your package manager
(`pnpm watch-tail <TAB>`).

`--profile` sets `AWS_PROFILE` for the server process only. Nothing is written to disk, and any local
emulator settings are neutralized for that run, so a stray `.env.local` cannot redirect a real AWS run.

## AWS access

Credentials are **ambient**: resolved by the AWS SDK provider chain - SSO, shared config, environment
variables or an instance role.

```bash
aws sso login --profile my-profile
watch-tail --profile my-profile
```

Two read-only actions are enough; the app never writes logs:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Action": ["logs:DescribeLogGroups", "logs:FilterLogEvents"],
			"Resource": "*"
		}
	]
}
```

Scope `Resource` down with a log-group ARN pattern if you only need a subset.

### When credentials are missing

On startup the CLI asks the running app for one log group. If AWS refuses because of credentials, it
works out which login command fixes it - from how your profile is configured, not from guesswork -
and offers to run it:

```text
warning: AWS credentials are not usable: ... The SSO session token associated with
         profile=my-profile was not found or is invalid.
? Sign in to the SSO session for my-profile. Run `aws sso login --profile my-profile` now? › yes
running aws sso login --profile my-profile
signed in - credentials work now
```

If you did not name a profile and you have more than one, it asks which one first. The answer decides
both the login and the profile the app runs with, so a chosen profile is applied by restarting the
server with it (and with that profile's own region). **A profile that already works is never sent to a
login prompt**: the CLI asks `sts:GetCallerIdentity` about the chosen profile first, and only offers a
login when that profile really has nothing usable.

```text
? Which AWS profile should watch-tail use?  (type to search, then Enter)
using profile beyond-mzansi
restarting with profile beyond-mzansi
profile beyond-mzansi already works (AWSReservedSSO_AWSAdministratorAccess) - using it
```

```text
? Which AWS profile should watch-tail use?  (type to search, then Enter)
using profile beyond-mzansi
? Sign in to the SSO session for beyond-mzansi. Run `aws sso login --profile beyond-mzansi` now? › yes
restarting with profile beyond-mzansi
signed in as beyond-mzansi - credentials work now
```

| Your profile                           | What it runs                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sso_session` / `sso_start_url`        | `aws sso login --profile <name>`                                                           |
| `login_session` (console sign-in)      | `aws login --profile <name>`                                                               |
| nothing configured yet                 | `aws login` (which creates the session)                                                    |
| static keys, or a `credential_process` | no login is offered - those are fixed with `aws configure` or where the process is defined |

The login runs with your terminal attached, so the browser flow works. `--remote` is added when there
is no browser (SSH, headless). Decline, or run non-interactively, and the CLI prints the exact command
instead and keeps the app up - log in elsewhere, then press Refresh. Emulator runs (`--endpoint`,
`--floci`) skip the check, because those use throwaway credentials by design.

**The region is optional.** Precedence is `--region`, then `AWS_REGION`/`AWS_DEFAULT_REGION`, then the
profile's own region, then `[default]` in `~/.aws/config`. Nothing resolvable produces a clear
`missing-region` message instead of a silent guess. Log groups, retention and events are per region,
so a group in `eu-west-1` will not appear under `us-east-2`.

### Local emulator

```bash
curl -fsSL https://floci.io/install.sh | sh
floci start
npx watch-tail --floci             # throwaway credentials are supplied automatically
```

`--floci` is the only thing that points the CLI at an emulator. If an `.env.local` next to the app
sets `AWS_ENDPOINT_URL` - as this repository's `pnpm floci:up` writes for the dev server - the CLI
ignores it, says so, and runs against real AWS; your own exported variables always win over that file.

## Local history

While a stream is open, every event that arrives is appended to a local DuckDB file. Nothing else
changes: the live tail, the historic scan and the UI work exactly as before. What the archive adds is
a **second source** you can read later.

In the UI, a **Local archive** toggle appears next to the mode controls whenever the archive is
available. Choosing it:

- lists the log groups the archive holds for the current region, with how many events are stored
  locally,
- replays a window from the file instead of calling CloudWatch - instant, and **no credentials
  needed**, so it works with an expired SSO session, offline, or on a machine that never had AWS
  access,
- keeps the same range controls (`15m` … `5d`, or a custom `from`/`to`), and puts the source in the URL
  so `…&source=archive&range=24h` is a shareable view of the archive.

```bash
watch-tail                            # archive on, file in your app data directory
watch-tail --db ./logs.duckdb         # keep the archive next to the project instead
watch-tail --no-archive               # do not archive anything
```

The default file is `archive.duckdb` inside your platform's data directory:

| Platform | Path                                                         |
| -------- | ------------------------------------------------------------ |
| macOS    | `~/Library/Application Support/watch-tail/archive.duckdb`    |
| Linux    | `${XDG_DATA_HOME:-~/.local/share}/watch-tail/archive.duckdb` |
| Windows  | `%LOCALAPPDATA%\watch-tail\archive.duckdb`                   |

`WATCH_STREAM_ARCHIVE=off` turns the archive off for the server, and `WATCH_STREAM_ARCHIVE_DB` sets the
file, for people who drive the server directly.

Because it is a DuckDB database, you can point any DuckDB client at the same file - with the app
stopped, since DuckDB allows one writer:

```bash
duckdb ~/Library/Application\ Support/watch-tail/archive.duckdb
```

```sql
SELECT log_group, count(*) AS events, max(timestamp_ms) AS newest
FROM log_events
GROUP BY log_group
ORDER BY events DESC;

SELECT to_timestamp(timestamp_ms / 1000) AS at, message
FROM log_events
WHERE log_group = '/aws/lambda/checkout' AND message ILIKE '%timeout%'
ORDER BY timestamp_ms;

-- how many errors per group, ignoring levels that were never detected
SELECT log_group, level, count(*) AS events
FROM log_events
WHERE level = 'error'
GROUP BY log_group, level
ORDER BY events DESC;
```

Three things worth knowing:

- **DuckDB is an optional dependency.** It is a native module (roughly 114 MB installed, prebuilt for
  every supported platform - no compiler needed). If it cannot be installed or loaded, `watch-tail`
  runs exactly as it did before, without history, and says so in the startup banner. To skip it
  deliberately: `npm install -g watch-tail --no-optional`.
- **One process owns the file.** DuckDB takes an exclusive lock, so a second `watch-tail` on the same
  archive runs without history while the first is up; `--db` is the way to keep two instances
  separate.
- Levels are detected, not received: CloudWatch Logs does not report a severity, so `error`/`warn`/
  `info`/`debug` come from the line itself, and `NULL` means nothing could be read from it.
- **The archive is as wide as what you watched.** Events are recorded as they stream, so history covers
  the windows you have actually visited. It is also local, unencrypted and outside your AWS account -
  treat the file like the logs themselves.

## Requests, not lines

Log lines that belong to the same request are one thing, not twenty. watch-tail reads a request id out
of each line - a declared `requestId` (also `request_id`, `awsRequestId`, an `x-request-id`) or the
`RequestId: ...` that a Lambda prints - and groups the lines that share it:

- **The log view** collapses each request into a single row: its request id, how many lines it wrote,
  how long it took, and the level of its **most critical line**, so a request with one error among
  twenty info lines reads as an error. Click the row to open it and see every line, indented, in order.
- **The chart** counts **one mark per request**, placed at the request's first line and coloured by
  that same most critical level, so a spike of failing requests is a spike of marks rather than a spike
  of log volume.
- **By request** in the log view's toolbar turns it off, and the view goes back to one row per line
  (and the chart back to one mark per line). Your choice is remembered.

Grouping is on by default. Lines with no request id are never grouped: each keeps its own row and its
own mark, so nothing is hidden by a request id the log did not have. A request whose lines span more
than one bucket is counted once, where it started, which is why the chart's total can be lower than
the number of lines.

## The chart

In **Historic** mode (and for the local archive) a scatter chart sits above the log view: X is time, Y
is the number of requests in a bucket, and each level is its own colour. Drag across it to brush a
range - the log view, the window chip and the URL all follow, so a brush is a shareable view of the
spike you just found. Click the chart to clear the brush, or press **Reset zoom** to go back to the
preset window. The level chips filter the chart and the log view together.

A drag only counts as a zoom when it is a real drag: a click, or a pointer that slips a couple of
pixels, clears the brush instead of zooming into a sliver of a window, and the view is re-scoped when
you release rather than while you drag - so the stream is not restarted mid-gesture.

With several groups selected, the counts cover all of them and the chart's legend splits the totals by
level. The level chips filter requests by their most critical level, which is the level the marks are
drawn in, so the legend and the filter never disagree. The archive answers the chart with one SQL query over the whole window; a CloudWatch view has no
aggregate API, so there the chart counts the events already in the view.

The panel has a header you can click to collapse it, and it remembers that choice: collapsed, it is
just one line of totals and per-level counts, and the space goes back to the log view.

The chart is drawn with [layerchart](https://www.layerchart.com), which is **loaded on demand**: the
charting code is fetched in the browser only once the panel is open, so it never delays the log view's
first paint. Measured on the production build, an open panel pulls about 235 KiB of chart code after
the page has started, and a collapsed one pulls none at all.

## Development

```bash
pnpm install
pnpm dev                                  # SvelteKit dev server on http://localhost:5173
                                          #   (its history archive lives in .watch-tail/)
pnpm seed                                 # fixtures in the local emulator (--watch for live traffic)
pnpm dev:aws --profile my-profile         # dev server against a real profile
pnpm build                                # adapter-node build + the CLI in dist/
pnpm start                                # run the built CLI
```

| Command                     | What it does                                                |
| --------------------------- | ----------------------------------------------------------- |
| `pnpm check`                | `svelte-check` types                                        |
| `pnpm test:unit`            | vitest unit, component and integration projects             |
| `pnpm test:e2e`             | floci integration suite (`WATCH_STREAM_E2E=1`)              |
| `pnpm test:cli`             | the built CLI serves and stops cleanly (`WATCH_TAIL_E2E=1`) |
| `pnpm test:ui`              | Playwright smoke check of the UI against a running app      |
| `pnpm lint` / `pnpm format` | oxlint / oxfmt                                              |
| `pnpm knip`                 | unused files, exports and dependencies                      |
| `pnpm verify`               | all of the above plus the build                             |
| `pnpm publish:check`        | publint plus the exact tarball contents                     |

## Releasing

Releases use [changesets](https://github.com/changesets/changesets): a changeset is a small file
that records _what changed and how much it matters_, reviewed with the code. Pending changesets are
folded into one "Release: version packages" PR; merging it bumps the version and writes
`CHANGELOG.md`; the release workflow then stages that version to npm and tags the commit.

```bash
pnpm changeset        # describe the change; the Version PR does the rest
pnpm changeset status # preview the next version
```

Publishing is **staged**, not direct: the tarball lands in npm's staging area and a human approves it
before it goes live, so no npm token exists in the repository - authentication is GitHub OIDC trusted
publishing, scoped to the publish job. See [RELEASING.md](./RELEASING.md) for the concept, the
one-time setup and the approval flow.

## Architecture

```
Browser (SvelteKit client)
  |  GET /api/log-groups        group list for a region
  |  GET /api/stream            SSE: ready, log, ping, error, end
  v
SvelteKit server routes (Node)
  |  @aws-sdk/client-cloudwatch-logs   DescribeLogGroups + FilterLogEvents polling
  v
CloudWatch Logs API   -- ambient AWS credentials
  or floci on http://localhost:4566

Everything streamed is also appended to a local archive,
which the UI can read back without AWS:

  SvelteKit server ---- @duckdb/node-api ----> archive.duckdb (DuckDB file)
                                             ^
  Browser  -- GET /api/stream?source=archive -+
```

The CLI (`src/cli/`) boots the packaged adapter-node server, waits for `/api/health` and opens a
browser. Full details, including the HTTP and SSE contract, are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Notes and limits

- CloudWatch Logs has no push API for reading, so the app polls `FilterLogEvents` (1 s by default,
  250 ms - 15 s configurable). Expect roughly a second of latency and one API call per second per open
  stream.
- `FilterLogEvents` only returns events from the last 14 days.
- The local server has no authentication: it binds to loopback and inherits your AWS permissions.
  Binding elsewhere prints a warning - only do it on a trusted network.
- floci omits `logStreamName` in `FilterLogEvents`, so the stream column stays empty locally; real AWS
  fills it.
- The archive is written from the same process that serves the UI, so it only grows while something is
  streaming. A window you never opened is not in it, and events dropped by the 10 000-event cap of a
  historic scan are not archived either.
- Archived events are de-duplicated by CloudWatch event id (or by a hash of timestamp, stream and
  message when an emulator omits ids), so re-scanning the same window does not duplicate rows.

## License

MIT - see [LICENSE](./LICENSE).
