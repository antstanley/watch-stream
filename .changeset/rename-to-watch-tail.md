---
'watch-tail': minor
---

Rename the project from `watch-stream` to `watch-tail` everywhere it still appeared, so the package,
the CLI, the docs and the source tree agree on one name. Environment variables are now
`WATCH_TAIL_REGIONS`, `WATCH_TAIL_LIMIT`, `WATCH_TAIL_ARCHIVE`, `WATCH_TAIL_ARCHIVE_DIR` and
`WATCH_TAIL_ARCHIVE_DB`, and the browser `localStorage` keys use the `watch-tail:` prefix. Set the new
names before upgrading: the old `WATCH_STREAM_*` variables are no longer read, and the renamed storage
keys reset saved layout preferences once.
