/**
 * Request grouping: the one place that decides what a "request" is.
 *
 * CloudWatch Logs has no concept of a request. A request is a set of lines that
 * share a log group and detected request id - a Lambda `REPORT RequestId: ...` line, an API
 * Gateway access log, a framework's structured `requestId` - and the same id
 * must produce the same group in the log view and in the chart. Both call the
 * helpers here, so a line that reads as one request in one view reads as one
 * request in the other.
 *
 * Design decisions:
 *
 * - A request is placed where it *starts* (its first line), because a request
 *   that logs for two minutes is one event that happened, not two.
 * - A request's level is its most critical line. An error is what a reader
 *   needs to see, even when twenty lines around it are info.
 * - Lines without a request id are not grouped: they keep their own row and
 *   their own chart mark, which is honest about what the log contains.
 */
import { detectRequestId, effectiveLevel, mostCriticalLevel, type LogLevel } from './log-buffer';
import type { LogEventDto, SeriesLevel } from './types';

/** One event plus where it appeared in the buffer, so a row can be rendered in place. */
type KeyedEvent = { event: LogEventDto; index: number };

/** Events that share a request id, oldest first. */
export type RequestGroup = {
	/** Request id every event in the group carries. */
	id: string;
	/** Most critical level in the group, or `unknown` when no line has one. */
	level: SeriesLevel;
	/** Timestamp of the first line, epoch ms. */
	first: number;
	/** Timestamp of the last line, epoch ms. */
	last: number;
	/** Lines of the request, in arrival order. */
	events: KeyedEvent[];
};

/** One rendered row: a line on its own, or a request and the lines it holds. */
export type RequestRow =
	| { kind: 'line'; key: string; event: LogEventDto; index: number }
	| { kind: 'request'; key: string; request: RequestGroup };

/**
 * Request id of an event.
 *
 * A value the server already detected wins, because it is the same value the
 * archive stored; only an event that carries no verdict is detected here.
 */
export function requestIdOf(event: LogEventDto): string | null {
	if (event.requestId !== undefined) {
		const declared = event.requestId;
		return declared === null || declared === '' ? null : declared;
	}
	return detectRequestId(event.message ?? '');
}

/** Level of a request: its worst line, or `unknown` when no line has a level. */
function requestLevel(events: readonly LogEventDto[]): SeriesLevel {
	return mostCriticalLevel(events.map((event) => effectiveLevel(event))) ?? 'unknown';
}

/** Groups events by log group and request id, keeping every timestamp and byte of the originals. */
export function collectRequests(events: readonly LogEventDto[]): RequestGroup[] {
	const byId = new Map<string, RequestGroup>();
	events.forEach((event, index) => {
		const id = requestIdOf(event);
		if (id === null) return;
		const key = JSON.stringify([event.group ?? '', id]);
		const existing = byId.get(key);
		if (existing === undefined) {
			byId.set(key, {
				id,
				level: 'unknown',
				first: event.timestamp,
				last: event.timestamp,
				events: [{ event, index }],
			});
			return;
		}
		existing.events.push({ event, index });
		if (Number.isFinite(event.timestamp)) {
			if (event.timestamp < existing.first) existing.first = event.timestamp;
			if (event.timestamp > existing.last) existing.last = event.timestamp;
		}
	});
	const groups = [...byId.values()];
	for (const group of groups) {
		group.level = requestLevel(group.events.map((entry) => entry.event));
	}
	return groups;
}

/** True when an event belongs to a request. */
export function hasRequestId(event: LogEventDto): boolean {
	return requestIdOf(event) !== null;
}

/**
 * Builds the log view's rows for a buffer.
 *
 * A request is placed where its first line appeared, so the view stays in time
 * order and a request never jumps down the list when its last line lands. The
 * lines inside a request keep their own order.
 */
export function requestRows(events: readonly LogEventDto[]): RequestRow[] {
	const at = new Map<number, RequestGroup>();
	for (const group of collectRequests(events)) {
		const first = group.events[0];
		if (first !== undefined) at.set(first.index, group);
	}
	const rows: RequestRow[] = [];
	events.forEach((event, index) => {
		const group = at.get(index);
		if (group !== undefined) {
			rows.push({
				kind: 'request',
				key: `req:${JSON.stringify([group.events[0]?.event.group ?? '', group.id])}`,
				request: group,
			});
			return;
		}
		// A line whose request was already emitted above belongs to that row.
		if (hasRequestId(event)) return;
		rows.push({ kind: 'line', key: `line:${index}`, event, index });
	});
	return rows;
}

/** Options for {@link bucketRequests}. */
export type BucketRequestsOptions = {
	/** Inclusive start of the window, epoch ms. */
	from: number;
	/** Exclusive end of the window, epoch ms. */
	to: number;
	/** Bucket width in ms. */
	bucketMs: number;
	/** Only count this level; `null` counts every level. */
	level?: LogLevel | null;
	/** Group name used for events that carry none. */
	fallbackGroup?: string;
};

/**
 * Counts requests into buckets, one mark per request, per group and level.
 *
 * A request is counted in the bucket its first line falls in, and only when
 * that first line is inside the window: a request that started before the window
 * is not re-counted in every bucket it touches. Lines that belong to no request
 * are still counted, each as one mark, so nothing disappears from the chart when
 * grouping is on. The level filter is applied to the request's most critical
 * level, matching what the archive answers, so the chips mean the same thing in
 * both sources.
 */
export function bucketRequests(
	events: readonly LogEventDto[],
	options: BucketRequestsOptions,
): { t: number; group: string; level: SeriesLevel; events: number }[] {
	const bucketMs = options.bucketMs > 0 ? Math.round(options.bucketMs) : 60_000;
	const levelFilter = options.level ?? null;
	const fallbackGroup = options.fallbackGroup ?? '';
	// A request is one mark, and a line that belongs to no request is a mark of its
	// own - the same rule the archive applies with `coalesce(request_id, event_key)`.
	// Dropping the loose lines would make the chart disagree with the log view.
	const marks: { t: number; group: string; level: SeriesLevel }[] = [];
	for (const group of collectRequests(events)) {
		marks.push({
			t: group.first,
			group: group.events[0]?.event.group ?? fallbackGroup,
			level: group.level,
		});
	}
	for (const event of events) {
		if (requestIdOf(event) !== null) continue;
		marks.push({
			t: event.timestamp,
			group: event.group ?? fallbackGroup,
			level: effectiveLevel(event) ?? 'unknown',
		});
	}
	const counts = new Map<
		string,
		{ t: number; group: string; level: SeriesLevel; events: number }
	>();
	for (const mark of marks) {
		const timestamp = mark.t;
		if (!Number.isFinite(timestamp)) continue;
		if (timestamp < options.from || timestamp >= options.to) continue;
		if (levelFilter !== null && mark.level !== levelFilter) continue;
		const t = Math.floor(timestamp / bucketMs) * bucketMs;
		const name = mark.group;
		const key = `${t}\u0000${name}\u0000${mark.level}`;
		const existing = counts.get(key);
		if (existing === undefined) counts.set(key, { t, group: name, level: mark.level, events: 1 });
		else existing.events += 1;
	}
	return [...counts.values()].toSorted((a, b) =>
		a.t === b.t ? a.level.localeCompare(b.level) : a.t - b.t,
	);
}
