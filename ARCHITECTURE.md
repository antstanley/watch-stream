# watch-stream architecture

`watch-stream` tails Amazon CloudWatch Logs and streams them into a local web UI.

```
Browser (SvelteKit client)
  |  fetch /api/log-groups      -> group list for a region
  |  EventSource /api/stream    -> live log events (SSE)
  v
SvelteKit server routes (Node, TypeScript)
  |  @aws-sdk/client-cloudwatch-logs  (DescribeLogGroups + FilterLogEvents polling)
  v
CloudWatch Logs API  --- ambient AWS credentials
  or floci on http://localhost:4566 (when AWS_ENDPOINT_URL is set)
```

## Layout

| Path                                      | Purpose                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `src/lib/types.ts`                        | Wire types shared by server routes and UI                            |
| `src/lib/regions.ts`                      | Canonical region list shared by server and browser                   |
| `src/lib/server/env.ts`                   | Effective env: `$env/dynamic/private` + `process.env` + `.env.local` |
| `src/lib/server/aws.ts`                   | Region/endpoint resolution, CloudWatch Logs client factory           |
| `src/lib/server/regions.ts`               | Region list for the picker                                           |
| `src/lib/server/log-groups.ts`            | `DescribeLogGroups` pagination                                       |
| `src/lib/server/tail.ts`                  | Polling tail engine: cursor, de-duplication, backoff, abort          |
| `src/lib/server/filter.ts`                | Duration parsing (`5m`, `2h`, epoch ms, ISO 8601)                    |
| `src/lib/server/sse.ts`                   | Server-sent event framing                                            |
| `src/routes/api/*`                        | JSON + SSE endpoints                                                 |
| `src/lib/components/*`                    | UI building blocks                                                   |
| `src/lib/log-buffer.ts`                   | Client-side ring buffer + text filter                                |
| `src/lib/log-format.ts`                   | JSON detection, pretty-printing and tokenizing                       |
| `src/lib/resize.ts`                       | Pure resize math and `localStorage` preference keys                  |
| `src/lib/time-range.ts`                   | Presets, window formatting and datetime-local conversions            |
| `src/lib/components/ColumnResizer.svelte` | Focusable drag handle for both resizable columns                     |
| `src/lib/components/RangeControls.svelte` | Live/Historic toggle, preset chips and custom window                 |
| `scripts/floci-env.ts`                    | Write/remove `.env.local` for the floci emulator                     |
| `scripts/seed-floci.ts`                   | Demo log groups, backfill and live traffic                           |
| `scripts/dev.ts`                          | Launcher: choose an AWS profile (`--profile`) or run local           |
| `scripts/ui-smoke.ts`                     | Playwright smoke check of the log window                             |

## HTTP API

### `GET /api/health`

```json
{
	"ok": true,
	"region": "us-east-1",
	"endpoint": "http://localhost:4566",
	"local": true,
	"credentials": "ambient"
}
```

`credentials` is `emulator-default` when the endpoint is a local emulator and no credential
variables are configured at all (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`,
`AWS_CONFIG_FILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`, the container-credential variables and
`AWS_ROLE_ARN` are all unset). In that case the client is built with `EMULATOR_CREDENTIALS`
(`test`/`test`) - floci and LocalStack accept any non-empty key pair and still sign requests, and
this branch can never run for a non-local endpoint. Any one of those variables being set keeps the
untouched SDK provider chain (`credentials: "ambient"`).

### `GET /api/regions`

```json
{
	"regions": ["us-west-1", "us-east-1", "us-west-2"],
	"defaultRegion": "us-west-1",
	"endpoint": null
}
```

`defaultRegion` is the region the server will use when a request does not name one, and it is
prepended to `regions` when `WATCH_STREAM_REGIONS` does not include it, so the picker can show one
entry more than the configured list.

The default list is `REGION_CODES` in `src/lib/regions.ts`: every region in the standard `aws`
partition that publishes a CloudWatch Logs endpoint (derived from the AWS CLI's
`botocore/data/endpoints.json`), including `af-south-1`. China, GovCloud and the ISO partitions are
excluded; set `WATCH_STREAM_REGIONS` to override the list entirely.

### `GET /api/log-groups?region=<region>&prefix=<prefix>&limit=<n>`

`region` is optional: without it the request uses the server's effective region (see
[Region resolution](#region-resolution)).

```json
{
	"region": "us-east-1",
	"endpoint": null,
	"groups": [{ "name": "/aws/lambda/checkout", "arn": "arn:...", "storedBytes": 1024 }]
}
```

Errors use `ApiErrorBody`: `{ "error": "...", "code": "...", "details": "..." }` with a
4xx status for bad input and 502 for upstream CloudWatch failures.

### `GET /api/stream` (Server-Sent Events)

Query parameters:

| Name            | Required | Meaning                                                                |
| --------------- | -------- | ---------------------------------------------------------------------- |
| `region`        | no       | AWS region to query; defaults to the effective region                  |
| `group`         | yes      | Log group name                                                         |
| `mode`          | no       | `live` (default) tails new events; `historic` scans a fixed window     |
| `range`         | no       | Historic preset: `15m`, `1h`, `3h`, `12h`, `24h`, `5d` (default `15m`) |
| `from` / `to`   | no       | Custom historic window: epoch ms or ISO 8601 (`from` takes `15m`)      |
| `filterPattern` | no       | CloudWatch filter pattern passed to `FilterLogEvents`                  |
| `startTime`     | no       | Start point: epoch ms, ISO 8601, or duration (`15m`, `2h`)             |
| `lookback`      | no       | Duration used when `startTime` is absent (default `5m`)                |
| `poll`          | no       | Poll interval in ms, clamped to 250..15000 (default 1000)              |

A historic request sets `endTime` on every `FilterLogEvents` call and ends by itself: with
`window-complete` once the window is exhausted (two empty polls, since ingestion can lag), with
`event-limit` after 10 000 events, or with `repeated-errors` after eight failed polls. Live requests
never end on their own - only a disconnected client stops them (`client-disconnected`).

Events:

| SSE event | Payload                                         |
| --------- | ----------------------------------------------- |
| `ready`   | `{ region, logGroupName, endpoint, startTime }` |
| `log`     | `{ events: LogEventDto[] }`                     |
| `ping`    | `{ at: number }` (sent every 15 s of silence)   |
| `error`   | `{ message, code? }`                            |
| `end`     | `{ reason }`                                    |

The stream stops when the browser disconnects (`request.signal` aborts).

## Region resolution

The region is resolved in this order:

1. the `region` query parameter (blank is treated as "not supplied"),
2. `AWS_REGION`, then `AWS_DEFAULT_REGION`,
3. the ambient AWS configuration the SDK reads itself: the active profile's `region`, then
   `[default]`'s region in `~/.aws/config`.

When none of these resolve, the client is created without a region and the SDK raises its own
error; that is mapped to code `missing-region` with the message
_"No AWS region is configured. Set AWS_REGION or add a region to your AWS profile."_
`FALLBACK_REGION` (`us-east-1`) is used only to display a region when resolution fails - it is
never sent to the SDK.

## Error codes

| Code                  | Status | Meaning                                                      |
| --------------------- | ------ | ------------------------------------------------------------ |
| `invalid-region`      | 400    | `region` param is not a plausible region code                |
| `invalid-limit`       | 400    | `limit` param is not an integer in 1..1000                   |
| `invalid-mode`        | 400    | `mode` is neither `live` nor `historic`                      |
| `invalid-range`       | 400    | `range` is not one of the offered presets                    |
| `invalid-time`        | 400    | `from`/`to` could not be parsed                              |
| `invalid-window`      | 400    | Window is missing a bound, inverted, or older than 14 days   |
| `missing-region`      | 502    | No region could be resolved from the parameter or AWS config |
| `missing-credentials` | 502    | No credentials could be resolved for a real AWS endpoint     |
| `access-denied`       | 502    | CloudWatch Logs refused the call                             |
| `not-found`           | 502    | The log group does not exist                                 |
| `throttled`           | 502    | CloudWatch Logs is rate limiting                             |
| `unreachable`         | 502    | Endpoint/DNS/connection failure                              |
| `aborted`             | 499    | The client closed the request before CloudWatch replied      |
| `unknown`             | 502    | Anything else                                                |

## Configuration

Ambient AWS credentials only, resolved by the SDK default provider chain
(`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, shared credentials file,
SSO, instance metadata). The app never stores credentials.

When `scripts/dev.ts` is used with `--profile`, it sets `AWS_PROFILE` in the child process and blanks
the local-emulator variables (`AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_LOGS`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) so a leftover `.env.local` cannot redirect a real-AWS
run; blank values are ignored by the SDK and by `normalize()`. It also resolves the region before
starting (`--region`, then the shell's `AWS_REGION`/`AWS_DEFAULT_REGION`, then the profile's `region`
in `~/.aws/config`) because the SDK rejects an empty `AWS_REGION` string.

SvelteKit exposes `.env` values through `$env/dynamic/private`, but the AWS SDK reads
`process.env` directly. `src/lib/server/env.ts` therefore loads `.env.local` into the process
once at startup (existing variables win, `node --env-file` semantics). `pnpm floci:up` writes
that file with the floci endpoint and its throwaway credentials.

| Variable                            | Purpose                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | Region before the ambient profile region; unset falls through      |
| `AWS_ENDPOINT_URL_LOGS`             | CloudWatch Logs endpoint override (checked first)                  |
| `AWS_ENDPOINT_URL`                  | Global endpoint override; set to `http://localhost:4566` for floci |
| `WATCH_STREAM_REGIONS`              | Narrow the picker; unset offers every CloudWatch Logs region       |
| `WATCH_STREAM_LIMIT`                | Default page size for `describe-log-groups`                        |
