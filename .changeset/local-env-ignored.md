---
'watch-tail': patch
---

Stop a development `.env.local` from silently redirecting the CLI at the emulator.

Running `watch-tail` inside a checkout that has a `.env.local` (written by
`pnpm floci:env` for the dev server) pointed the whole UI at floci instead of
real AWS. The CLI now suppresses the emulator settings it finds in that file,
prints which keys it ignored, and tells you `--floci` is the way to use them.
Values you export yourself still win, and `--floci` still targets the emulator.
