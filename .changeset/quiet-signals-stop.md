---
'watch-tail': patch
---

Fix Ctrl+C leaving the dev server running after a log stream has been opened. Preserve normal signal termination across hot reloads, and clean up the CLI child server when startup is cancelled.

Fix Ctrl+C after choosing an AWS profile: pipe server output through the CLI so a restarting child cannot restore raw terminal settings. Install shutdown handlers before displaying the Ctrl+C instruction, and test the interactive restart with real terminal input.
