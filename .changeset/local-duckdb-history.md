---
'watch-tail': minor
---

Keep a local DuckDB archive of everything you stream, and browse it without AWS

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
