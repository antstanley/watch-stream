# watch-stream

Stream Amazon CloudWatch Logs into a local web app. Pick a region, pick a log group, watch the
events arrive.

- **Local UI** — SvelteKit + Svelte 5 + Tailwind, served on `http://localhost:5173`.
- **Ambient credentials** — the server uses the AWS SDK default credential chain. Log in with the
  AWS CLI or SSO beforehand; the app never stores or asks for keys.
- **Server-sent events** — the browser gets a `text/event-stream` feed of log events.
- **Readable log window** — long lines scroll sideways instead of wrapping (or toggle **Wrap**),
  JSON entries are pretty-printed and coloured (toggle **JSON**), and both the group-list pane and
  the timestamp/stream column are drag-resizable. Preferences stick in `localStorage`.
- **floci-ready** — run the whole thing against the [floci](https://floci.io) local AWS emulator,
  no AWS account needed.

```
┌──────────────────────────────┬──────────────────────────────────────────────────────┐
│ region  eu-west-1            │  ● live  1 204 events      [pause] [clear] [☑ scroll] │
│ ──────────────────────────── │  filter: ______________________                       │
│ ▸ /aws/lambda/checkout-api   │  12:03:41.221 9f2c1a4b  START RequestId: 8f2c…       │
│ ▸ /aws/lambda/order-worker   │  12:03:41.229 9f2c1a4b  {"level":"info","msg":"cart… │
│ ▸ /app/api/gateway           │  12:03:41.512 gateway-a WARN slow upstream /v1/cata… │
│ ▾ /app/worker/queue          │  12:03:42.004 worker-0  ERROR job 71 failed: schema  │
└──────────────────────────────┴──────────────────────────────────────────────────────┘
```

## Requirements

- Node.js 24+ (the seed scripts run `.ts` files through Node's type stripping)
- pnpm 10+
- Either ambient AWS credentials, or floci for a fully local run

## Quick start with floci (no AWS account)

```bash
# 1. install and start the local AWS emulator
curl -fsSL https://floci.io/install.sh | sh
pnpm floci:up          # floci start + writes .env.local from `floci env`

# 2. create sample log groups and backfill events
pnpm seed              # add --watch to keep new events flowing

# 3. run the app
pnpm dev               # http://localhost:5173
```

`pnpm floci:up` writes `.env.local` with `AWS_ENDPOINT_URL`, dummy credentials, `AWS_REGION=us-east-1`
and a region list. The server loads that file into `process.env` at startup (existing variables
win), because the AWS SDK reads the process environment directly rather than SvelteKit's `$env`
modules. `.env.local` is git-ignored; delete it to go back to real AWS. Verify the setup at any time
with:

```bash
pnpm floci:env -- --check
```

Want a different region in the demo - `af-south-1`, say?

```bash
pnpm seed -- --region af-south-1              # fixtures for the Cape Town region
pnpm seed -- --region af-south-1 --watch      # and keep events flowing
pnpm dev                                      # pick af-south-1 from the region list
```

The picker offers every region where CloudWatch Logs exists (33 regions, including `af-south-1`)
unless you narrow it with `WATCH_STREAM_REGIONS`.

**floci stores log data per region**, and `.env.local` pins `AWS_REGION=us-east-1`. `pnpm seed`
writes to that same region, so the demo groups appear under `us-east-1`. Switch the picker to
another region and the list is empty - that is the correct per-region behaviour, not a bug. To
exercise the "no region configured" path instead, remove **both** the `AWS_REGION` and
`AWS_DEFAULT_REGION` lines from `.env.local`; the app then uses your AWS profile's region (and floci
shows nothing there until you seed that region).

A local emulator never needs real credentials: if the endpoint is local and no credential variables
are set at all, the server signs requests with floci's documented throwaway keys (`test`/`test`),
`/api/health` reports `"credentials": "emulator-default"`, and the header shows a small `dev creds`
hint next to the endpoint badge.

## Using real AWS

The app talks to whatever account your shell is logged into. It reads credentials through the SDK
default provider chain and never stores them, so log in first.

```bash
# 1. log in with the AWS CLI (SSO, IAM keys, or a profile)
aws sso login --profile my-profile
aws sts get-caller-identity --profile my-profile   # confirm it works

# 2. start the app with that profile
pnpm dev:aws --profile my-profile
pnpm dev:aws --profile my-profile --region eu-west-1   # pick the region the UI opens on
pnpm start:aws --profile my-profile                    # production build instead
```

Launcher helpers:

```bash
pnpm dev:aws --list                              # profiles in ~/.aws/config and ~/.aws/credentials
pnpm dev:aws --profile my-profile --print        # show the AWS_* environment it would use, start nothing
pnpm dev:aws --profile my-profile --port 5199    # custom port
```

`--profile` sets `AWS_PROFILE` for the server process only and neutralizes any local emulator settings
for that run, so you do **not** have to delete `.env.local`: `pnpm dev` keeps running against floci,
while `pnpm dev:aws --profile …` talks to real AWS. Credentials are still resolved by the AWS SDK
(SSO, keys, assume-role, instance role) - nothing is stored, and the flag changes no files.

With `--profile`, the region comes from `--region`, then `AWS_REGION`/`AWS_DEFAULT_REGION` in your
shell, then the profile's own `region` in `~/.aws/config`. A profile without a `region` and no
`--region` makes the app answer with the `missing-region` message instead of guessing, and the
launcher prints `no region found for profile "X"; pass --region <code> to set one.` on stderr.

`--print` and `--list` write only data to stdout (one `KEY=value` or profile name per line) and exit
0, so they can be scripted; warnings and notes go to stderr. Bad arguments exit 2 with usage.

`AWS_ENDPOINT_URL` is what points the app at floci. With `.env.local` gone (or no
`AWS_ENDPOINT_URL`/`AWS_ENDPOINT_URL_LOGS` exported) requests go to the real CloudWatch Logs API.
Check the header badge: it shows **`floci http://…`** for a local endpoint and nothing for real AWS.
`curl localhost:5173/api/health` confirms it too: `{ "endpoint": null, "local": false }`.

### IAM permissions

Two read-only actions are enough — the app never writes logs:

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

Scope `Resource` down with a log-group ARN pattern (for example
`arn:aws:logs:eu-west-1:123456789012:log-group:/aws/lambda/*`) if you only need a subset.
`logs:DescribeLogGroups` is account-wide by nature, so `"Resource": "*"` is normal for it.

### Account, region and profile

- One credential set per server process. To switch account or profile, restart `pnpm dev` with a
  different `AWS_PROFILE`; the browser does not choose credentials.
- **You do not have to name a region.** Precedence is: the `region` query parameter, then
  `AWS_REGION`/`AWS_DEFAULT_REGION`, then whatever your AWS config says (the active profile's
  `region`, then `[default]`). So `AWS_PROFILE=my-profile pnpm dev` opens on that profile's region.
  If nothing resolves, requests fail with a clear `missing-region` message.
- The picker still lets you switch any time - it sends `?region=` on every request, no restart
  needed. Use `WATCH_STREAM_REGIONS` to limit the list:

  ```bash
  WATCH_STREAM_REGIONS=eu-west-1,eu-west-2,us-east-1 pnpm dev
  ```

- Log groups, retention and events are all per region, so a group that exists in `eu-west-1` will
  not appear when you select `us-east-2`.
- The region shown in the header is the one actually used; when the server had to fall back because
  nothing was resolvable, the picker still shows a starting point and the request reports
  `missing-region`.
- Cross-account access works the same way as the CLI: assume the role first
  (`aws sso login`/`credential_process`) and start the app with that profile.

### Switching back to floci

```bash
pnpm floci:up && pnpm seed     # restores .env.local and the demo fixtures
```

Exporting `AWS_*` variables only overrides individual values: `.env.local` still wins for any
variable you leave unset, so remove the file when you are done with the emulator.

## The log window

| Control                                 | Behaviour                                                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wrap** (default off)                  | Lines stay on one line and the window scrolls sideways; turn Wrap on to fold long lines instead                                                                                                                                                                            |
| **JSON** (default on)                   | Entries whose message is entirely a JSON object/array are pretty-printed with syntax colouring; turn it off to see the raw line                                                                                                                                            |
| Prefix handle                           | Drag the handle between the stream name and the message (or focus it and press Left/Right) to resize the timestamp + stream column. Stream names are truncated with the full value in the tooltip, so a 95-character Lambda stream name cannot push the message off screen |
| Sidebar handle                          | Drag the handle between the group list and the log window (or focus it and press Left/Right) to resize the pane                                                                                                                                                            |
| **Pause** / **Clear** / **Auto-scroll** | Freeze the view while buffering, empty the buffer, or follow the newest line                                                                                                                                                                                               |

Widths and toggles persist per browser under `watch-stream:*` keys in `localStorage`. Only the raw
message is used for filtering and level detection, so pretty-printing never hides a line.

### Layout

The shell fills the window: content is left-aligned with no centred max-width, and the two panes take
all the space between the header and the bottom edge, at any window size. Long content scrolls inside
its own pane - the group list and the log window each keep their own scrollbar - so the page itself
never scrolls. Below 30 rem of height the layout keeps a minimum and the page scrolls instead of
squashing the viewer.

### Live and historic

The **Live / Historic** toggle above the panes switches between following new events and scanning a
fixed window:

| Control            | Behaviour                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Live** (default) | Tails from now, exactly as before; the toolbar chip reads `live`                                             |
| **Historic**       | Scans a fixed window and stops when it is done. Presets: 15 min, 1 hour, 3 hours, 12 hours, 24 hours, 5 days |
| **Custom…**        | Opens two `datetime-local` fields; Apply accepts any window up to 14 days                                    |

A historic scan ends on its own and the toolbar shows `window complete`. Ask for more than CloudWatch
Logs keeps and the server clamps the start to the last 14 days, marking the chip `14-day limit`.
Huge windows stop after 10 000 events, and switching back to **Live** restarts the tail.

The view is shareable: the URL carries `mode=historic` plus either `range=24h` or `from`/`to` in epoch
milliseconds, for example
`/?region=af-south-1&group=/aws/lambda/checkout-api&mode=historic&range=24h`.

## Configuration

| Variable                            | Default                      | Purpose                                               |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------- |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | `us-east-1`                  | Default region                                        |
| `AWS_ENDPOINT_URL_LOGS`             | –                            | CloudWatch Logs endpoint override (checked first)     |
| `AWS_ENDPOINT_URL`                  | –                            | Endpoint override for all AWS calls; set by floci     |
| `WATCH_STREAM_REGIONS`              | every CloudWatch Logs region | Narrow the picker, for example `eu-west-1,af-south-1` |
| `WATCH_STREAM_LIMIT`                | `200`                        | Default page size for `describe-log-groups`           |

Credentials are always ambient: `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`, the shared credentials file, SSO, or an instance role. Copy `.env.example` to
`.env.local` to set the non-secret values.

## How streaming works

CloudWatch Logs has no push API for reading a log group, so the server polls:

1. `DescribeLogGroups` fills the group list for the selected region.
2. `FilterLogEvents` is polled every second (configurable per request, 250 ms – 15 s) with a moving
   `startTime` cursor. `startTime` is inclusive, so events are de-duplicated by CloudWatch event id
   in a bounded seen-set (5 000 ids) before they leave the server.
3. Each new batch is written to the SSE stream as an `log` event. `ping` events keep idle
   connections alive; `error` events report upstream failures without dropping the stream.
4. Transient failures back off exponentially (1 s → 15 s, up to 8 consecutive failures) and the
   stream ends with an `end` event when the browser disconnects.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map and the full HTTP/SSE contract.

## Scripts

| Command                             | What it does                                                            |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`                          | SvelteKit dev server on http://localhost:5173                           |
| `pnpm build` / `pnpm start`         | Production build with adapter-node, then run it                         |
| `pnpm dev:aws` / `pnpm start:aws`   | run against a real AWS profile (`--profile NAME`, `--region`, `--port`) |
| `pnpm check`                        | `svelte-check` type check                                               |
| `pnpm test`                         | vitest (unit + component projects)                                      |
| `pnpm test:e2e`                     | integration tests against floci (`WATCH_STREAM_E2E=1` + `.env.local`)   |
| `pnpm test:ui`                      | Playwright smoke check of the log window against a running app          |
| `pnpm lint` / `pnpm lint:fix`       | oxlint                                                                  |
| `pnpm format` / `pnpm format:check` | oxfmt                                                                   |
| `pnpm knip`                         | unused files, exports and dependencies                                  |
| `pnpm verify`                       | check + lint + format:check + test + knip + build                       |
| `pnpm floci:up` / `pnpm floci:stop` | start/stop the emulator and write `.env.local`                          |
| `pnpm floci:env -- --remove`        | delete `.env.local` to go back to real AWS                              |
| `pnpm seed` / `pnpm seed:watch`     | fixtures for floci; `--watch` emits live traffic                        |

Extra seed flags: `--endpoint URL`, `--region R`, `--interval MS`, `--backfill N`,
`--backfill-minutes N`, `--reset`, `--allow-remote`.

## Testing

```bash
pnpm test                                     # unit + component (no network)
pnpm vitest run src/lib/server                # one area at a time
pnpm floci:up && pnpm seed && pnpm test:e2e   # real stream through floci
```

| Project       | Files                            | Environment                               |
| ------------- | -------------------------------- | ----------------------------------------- |
| `server`      | `src/**/*.{test,spec}.ts`        | Node, fake SDK clients, no network        |
| `client`      | `src/**/*.svelte.{test,spec}.ts` | jsdom + `@testing-library/svelte`         |
| `integration` | `tests/**/*.{test,spec}.ts`      | Node, runs only with `WATCH_STREAM_E2E=1` |

### Browser smoke check

`pnpm test:ui` drives the app in a real headless browser (Playwright with the Google Chrome already
on the machine, so nothing is downloaded) and checks what unit tests cannot: horizontal scrolling,
the wrap and JSON toggles, and dragging both resizable columns. It needs a running app and only
reads the page - it never writes to AWS.

```bash
pnpm dev                       # or your own instance
pnpm test:ui                   # http://localhost:5173, first log group in the list
pnpm test:ui -- --url http://localhost:5196 --region us-east-1 --group /aws/lambda/checkout-api
pnpm test:ui -- --screenshot /tmp/ui.png --timeout 20000 --channel chromium
```

Each check prints `PASS`/`FAIL` with its evidence and the script exits non-zero on failure, so it
works as a gate. The suite covers the log window (scrolling, wrapping, JSON, both resizers) and the
live/historic toggle: presets appear, selecting one scopes the window, a 15-minute scan finishes on
its own, and switching back to live restarts the tail. A group with no recent events reports `FAIL log lines rendered` - widen the
lookback in the UI or pick another group.

The integration project reads `.env.local`, creates a throwaway log group
(`/watch-stream/e2e-<timestamp>`), backfills events, tails them through the real SDK, reads the SSE
route, and deletes the group afterwards. It needs a reachable emulator endpoint.

## Limitations

- Polling, not `StartLiveTail` — the subscription-filter API is not available on the emulator, and
  polling keeps one code path for real AWS and floci. Expect ~1 s of latency and one API call per
  second per open stream.
- `FilterLogEvents` only returns events from the last 14 days.
- Each open browser tab holds one polling stream. Close tabs you do not need.
- The local server has no authentication: it inherits your AWS permissions and should only be bound
  to localhost.

## Troubleshooting

| Symptom                                 | Fix                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `missing-credentials` in the UI         | Log in first (`aws sso login`, `aws configure`) or export keys; with a local emulator the app falls back to throwaway keys by itself |
| Region is not the one you expected      | Precedence is `?region=`, `AWS_REGION`/`AWS_DEFAULT_REGION`, then your AWS profile; `.env.local` pins `us-east-1` in local mode      |
| `unreachable` errors                    | Is floci running? `floci status`, then `pnpm floci:up`                                                                               |
| Empty group list                        | Wrong region, or no log groups there; run `pnpm seed` against floci                                                                  |
| Stream connects but no events           | The group may have had no events in the lookback window; widen it with the lookback control                                          |
| No stream names on log lines            | floci omits `logStreamName` in `FilterLogEvents`; real AWS returns it                                                                |
| `AWS_PROFILE` set but expired           | The emulator fallback never overrides explicit config: run `aws sso login`, or unset `AWS_PROFILE` so the throwaway keys apply       |
| `missing-region` for a real-AWS run     | Your profile has no `region` and none was passed: `pnpm dev:aws --profile X --region eu-west-1`                                      |
| Stale `.env.local` after stopping floci | `rm .env.local` to fall back to real AWS                                                                                             |

## License

MIT - see [LICENSE](./LICENSE).
