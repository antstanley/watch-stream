---
'watch-tail': minor
---

Detect unusable AWS credentials at startup, and offer the login that fixes them.

The CLI now asks the running app for one log group before opening the browser. If
AWS refuses because of credentials, it reads how the profile is configured and
offers the matching command: `aws sso login --profile X` for SSO profiles,
`aws login --profile X` for console sign-in profiles (or one with nothing
configured yet), and no login at all for static keys or a `credential_process`,
where the fix is elsewhere. The login runs with the terminal attached, so the
browser flow works; `--remote` is added on headless hosts. Decline, and it prints
the command instead and leaves the app running. Emulator runs skip the check.
