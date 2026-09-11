---
'watch-tail': patch
---

Make shell completions complete the values that matter.

`--profile` now offers the profiles from your own AWS config instead of just
`default`, `--region` offers the CloudWatch Logs region list, `--open` is
completable, and the stray `presets` pseudo-command is gone. The completion
protocol is covered by tests, including a generated script for each supported
shell.
