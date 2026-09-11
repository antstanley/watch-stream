---
'watch-tail': minor
---

First public release of `watch-tail`.

`npx watch-tail` starts a local UI for Amazon CloudWatch Logs and streams a log
group into your browser: region and group pickers, live tailing over SSE, historic
scans (15m/1h/3h/12h/24h/5d or a custom window), JSON pretty-printing, resizable
columns, and ambient AWS credentials throughout. It runs against real AWS, or
against the floci emulator with `--floci`.
