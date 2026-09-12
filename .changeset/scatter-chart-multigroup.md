---
'watch-tail': minor
---

See the shape of an incident: a level-coloured scatter chart, brushing, and several groups at once

A scatter chart now sits above the log view. X is time, Y is the number of events in a bucket, and
every level gets its own colour, so a spike reads as errors or as noise before you scroll a single
line. Drag across the chart to brush a range: the log view, the window chip and the URL all follow, so
`?from=&to=` is a shareable view of that moment. A click clears the brush and **Reset zoom** returns to
the preset window. The level chips filter the chart and the log view together, and the chart's legend
splits the totals by level.

The sidebar now takes more than one log group. Ticking extra groups streams them together, adds a
group column to the view, covers all of them in the chart, and keeps the selection in the URL as
`groups=a,b` (a single group still uses `group=a`, so older links keep working). The archive reads
several groups in one SQL statement; CloudWatch runs one tail per group and merges them, so a quiet
group never holds back a busy one.

The brush zooms when the drag is released, not while the pointer is down, and a click or a slipped
pointer clears the brush instead of zooming to a sliver of the window.

The chart panel collapses to a single header line (totals and per-level counts) and remembers that
choice, and the charting library is loaded on demand: the chart code is fetched in the browser only
once the panel is open, so it never delays the log view's first paint (about 235 KiB of chart code
after the page starts, and none at all while collapsed).

`GET /api/series` is the chart's data: bucketed counts per group and level, with an automatic bucket
width, an optional `bucket`, a `level` filter, and no 14-day clamp - the archive keeps what CloudWatch
has forgotten. The chart is drawn with [layerchart](https://www.layerchart.com).
