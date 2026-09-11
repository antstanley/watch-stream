---
'watch-tail': minor
---

Check a chosen profile with STS before offering to log it in.

Picking a profile no longer assumes it needs a login: the CLI restarts with it and
asks `sts:GetCallerIdentity` about _that_ profile, so a profile whose SSO session
is still cached is simply used - "profile beyond-mzansi already works
(AWSReservedSSO_AWSAdministratorAccess) - using it" - instead of prompting for a
login anyone would have to cancel. A login is offered only when the chosen
profile genuinely has nothing usable, and after a successful login the result is
confirmed with STS and reported by role name.

Adds `GET /api/identity`, which returns the caller identity for the resolved
configuration (arn, account, userId, region, endpoint) using the same credentials
and endpoint resolution as the log routes.
