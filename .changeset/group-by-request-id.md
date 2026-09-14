---
'watch-tail': minor
---

Group the lines of a request into one row, in the log view and in the chart.

A request id is read from each line - a declared `requestId` (also `request_id`, `awsRequestId`,
`x-request-id`) or the `RequestId: ...` a Lambda prints - and the lines that share it become one row in
the log view: the request id, how many lines it wrote, how long it took, and the level of its most
critical line. Click the row to open every line, indented and in order.

The chart counts one mark per request instead of one per line, placed where the request started and
coloured by that same most critical level, so a spike of failing requests is a spike of marks rather
than a spike of log volume. The archive answers that in one SQL statement, and a CloudWatch view
buckets the requests it has already streamed.

It is on by default and the log view's **By request** button turns it off, which the app remembers.
Lines with no request id are never grouped, so nothing is hidden by an id the log did not have.
