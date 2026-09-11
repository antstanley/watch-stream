---
'watch-tail': minor
---

Open a single log line's JSON on click, and give the app its own icon.

With pretty-printing switched off, a line that carries JSON shows a marker and
opens on click: the raw line stays where it is and the payload appears beneath
it, indented and coloured - including for the "prefix then payload" lines
CloudWatch often receives. Clicking again, or pressing Enter, closes it. Lines
without JSON are not controls, so nothing pretends to be clickable.

The stock framework icon is replaced with one of our own: a log window with the
newest line highlighted.
