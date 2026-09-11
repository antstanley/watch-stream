<div align="center">

# watch-tail

**Tail Amazon CloudWatch Logs in your browser.**

Pick a region, pick a log group, watch the events arrive - live, or over any
historic window. Ambient AWS credentials only; your keys never leave the AWS SDK.

[![npm version](https://img.shields.io/npm/v/watch-tail?color=blue)](https://www.npmjs.com/package/watch-tail)
[![CI](https://github.com/antstanley/watch-stream/actions/workflows/ci.yml/badge.svg)](https://github.com/antstanley/watch-stream/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/watch-tail)](./LICENSE)
[![node](https://img.shields.io/node/v/watch-tail)](package.json)

<img src="./docs/screenshot.png" alt="watch-tail streaming CloudWatch Logs" width="900">

</div>

```bash
npx watch-tail                      # uses your ambient AWS credentials
npx watch-tail --profile my-profile --region af-south-1
npx watch-tail --floci              # or a local emulator, no AWS account
```

## What you get

- **Region-first UI** - the region picker lists log groups, and selecting one starts streaming.
- **Live and historic** - follow new events, or scan 15 min / 1 h / 3 h / 12 h / 24 h / 5 days, or
  any custom `from`/`to` window up to the 14 days CloudWatch Logs keeps.
- **A log window built for real logs** - long lines scroll sideways (or wrap), JSON entries are
  pretty-printed with syntax colouring, and both the stream-name column and the group-list pane
  are drag-resizable. Stream names are truncated with the full value in a tooltip, so a
  95-character Lambda stream name cannot push the message off screen.
- **Server-sent events** - the browser gets a live `text/event-stream` feed, with client-side pause,
  buffering, filtering, auto-scroll and a 5 000-line ring buffer.
- **One command** - `watch-tail` builds nothing, needs no config file, and shuts down cleanly on
  Ctrl+C.

## Install

```bash
npx watch-tail              # no install
pnpm add -g watch-tail      # or install once
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
  -h, --help             Show this help
  -v, --version          Show the version
```

The CLI also ships shell completions, powered by [`@bomb.sh/tab`](https://bomb.sh):

```bash
source <(watch-tail complete zsh)     # zsh; bash, fish and powershell too
watch-tail complete zsh > ~/.watch-tail-completion.zsh
```

`--profile` sets `AWS_PROFILE` for the server process only. It never writes anything to disk, and it
neutralizes any local emulator settings for that run, so a stray `.env.local` cannot redirect a real
AWS run.

## AWS access

The app uses **ambient credentials**, resolved by the AWS SDK default provider chain - SSO, shared
config, environment variables, or an instance role:

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

**The region is optional.** Precedence is `--region`, then `AWS_REGION`/`AWS_DEFAULT_REGION`, then
the profile's own region, then `[default]` in `~/.aws/config`. Nothing resolvable produces a clear
`missing-region` message rather than a silent guess. Log groups, retention and events are per
region, so a group in `eu-west-1` will not appear under `us-east-2`.

### Local emulator

[floci](https://floci.io) is a drop-in local AWS emulator on port 4566, which makes development
fast and free:

```bash
curl -fsSL https://floci.io/install.sh | sh
floci start
npx watch-tail --floci             # throwaway credentials are supplied automatically
```

## Historic windows

The **Live / Historic** toggle above the panes switches from following new events to scanning a
fixed window. A historic scan ends on its own and the toolbar shows `window complete`; the window is
shown in the URL, so any view is shareable:

```
http://127.0.0.1:4517/?region=af-south-1&group=/aws/lambda/checkout-api&mode=historic&range=24h
```

Windows older than 14 days are clamped (and marked `14-day limit`), huge scans stop after 10 000
events, and switching back to **Live** restarts the tail.

## Development

```bash
pnpm install
pnpm dev                     # SvelteKit dev server on http://localhost:5173
pnpm seed                    # fixtures in the local emulator (add --watch for live traffic)
pnpm dev:aws --profile my-profile    # dev server against a real profile
pnpm build                   # adapter-node build + the CLI in dist/
pnpm start                   # run the built CLI
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

The browser smoke check reads the running UI and never writes to AWS:

```bash
pnpm dev
pnpm test:ui                                   # or -- --url http://127.0.0.1:4517 --channel chromium
```

## Publishing

Releases are **staged** to npm through GitHub OIDC trusted publishing: no tokens exist in the
repository, and a human approves the staged package before it goes live. See
[RELEASING.md](./RELEASING.md) for the one-time setup and the release flow. Changesets drive
versioning:

```bash
pnpm changeset
```

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
```

The CLI (`src/cli/`) boots the packaged adapter-node server, waits for `/api/health`, and opens a
browser. Full details, including the HTTP and SSE contract, are in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Notes and limits

- CloudWatch Logs has no push API for reading, so the app polls `FilterLogEvents` (1 s by default,
  250 ms - 15 s configurable). Expect roughly a second of latency and one API call per second per
  open stream.
- `FilterLogEvents` only returns events from the last 14 days.
- The local server has no authentication: it binds to loopback and inherits your AWS permissions.
  Binding elsewhere prints a warning - only do it on a trusted network.
- floci omits `logStreamName` in `FilterLogEvents`, so the stream column stays empty locally;
  real AWS fills it.

## License

MIT - see [LICENSE](./LICENSE).
