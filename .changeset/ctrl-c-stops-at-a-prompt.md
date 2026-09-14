---
'watch-tail': patch
---

Make Ctrl+C stop the CLI while a prompt is open.

Cancelling one of the CLI's questions (the login offer, the profile picker) was read as "No" - so
Ctrl+C at that prompt looked like it did nothing, and the process carried on with its server still
running. Worse, the question left the terminal in raw mode, where Ctrl+C no longer produces a signal at
all, so every later attempt in that terminal was swallowed too.

A cancelled prompt is now a stop: the CLI says `Cancelled.`, shuts the server down, prints `stopped`,
exits like any other Ctrl+C, and hands the terminal back in its normal state. If a terminal was already
left in raw mode by an earlier version, `stty sane` repairs it.
