---
'watch-tail': patch
---

Refresh archive account mappings before reading, using cached identities only when lookup fails.
Resolve STS endpoints separately from CloudWatch Logs so Logs-specific endpoints do not disable archiving.
