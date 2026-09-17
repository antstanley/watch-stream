---
'watch-tail': minor
---

Store default DuckDB archives separately for each AWS account and region. Verify account IDs with
STS before writing, isolate emulator endpoints, and cache account mappings for offline reads.
Region changes now select the matching archive for status, groups, logs, and charts. Existing archives
remain untouched and can be opened with the explicit `--db` file override.
