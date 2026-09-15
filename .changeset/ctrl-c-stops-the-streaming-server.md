---
'watch-tail': patch
---

Stop the server immediately when it is streaming.

adapter-node shuts down gracefully: on Ctrl+C it stops accepting connections and waits for the ones
already open, force-closing them only after `SHUTDOWN_TIMEOUT` - thirty seconds by default. A live tail
never finishes on its own, so a server with a browser on it took half a minute to stop, which reads
exactly like "Ctrl+C does not stop the server".

The app now ends its own event streams when it is asked to stop, so the shutdown completes at once, and
the stream says why it ended (`server-stopping`) instead of the browser seeing a dead socket. The CLI
and the dev launcher also pass a two-second `SHUTDOWN_TIMEOUT` as an outer bound. The regression test
runs the built server with a live tail attached and asserts it exits promptly.
