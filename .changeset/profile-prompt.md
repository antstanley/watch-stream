---
'watch-tail': patch
---

Ask which AWS profile to use when credentials fail, and keep prompts working with NO_COLOR set.

With several profiles configured, a credential failure assumed the ambient default
and offered to log in there - rarely the account someone meant. The CLI now asks
which profile to use (a searchable list; skipped when `--profile` or `AWS_PROFILE`
already answers it, or when only one profile exists), runs the matching login for
it, and restarts the app with that profile and its own region so the browser lands
on a working session. Declining still leaves the app running as the chosen profile,
with the exact command to run.

`NO_COLOR` no longer disables prompts. It asks for no colour, and reading it as
"do not prompt" silently skipped the profile and login questions for anyone who
sets it.
