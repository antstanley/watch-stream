/**
 * Client-side bucketing for the chart.
 *
 * The archive answers `/api/series` with counts it can compute in DuckDB, but a
 * CloudWatch view has no aggregate API, so the events already streamed into the
 * view are bucketed here instead. Both paths produce the same
 * {@link SeriesPoint} shape, so the chart has one data contract.
 */
import { eventDurationMs } from './request-duration';
import { effectiveLevel, type LogLevel } from './log-buffer';
import { bucketRequests, collectRequests } from './request-groups';
import type { LogEventDto, SeriesLevel, SeriesPoint } from './types';

/** Severity order used wherever levels are listed. */
export const LEVEL_ORDER: readonly SeriesLevel[] = ['error', 'warn', 'info', 'debug', 'unknown'];

/** Label shown for a level. */
export const LEVEL_LABELS: Record<SeriesLevel, string> = {
	error: 'Error',
	warn: 'Warn',
	info: 'Info',
	debug: 'Debug',
	unknown: 'No level',
};

/**
 * Chart palette per level, matching the colours the log viewer uses for lines.
 *
 * SVG needs real colour values rather than Tailwind classes, so the palette is
 * kept next to the level helpers instead of in the component.
 */
export const SERIES_LEVEL_COLOR: Record<SeriesLevel, string> = {
	error: '#f87171',
	warn: '#fcd34d',
	info: '#a3a3a3',
	debug: '#737373',
	unknown: '#525252',
};

/** Bucket width used when a caller does not ask for one. */
export const DEFAULT_BUCKET_MS = 60_000;

/** Options for {@link bucketEvents}. */
export type BucketEventsOptions = {
	/** Inclusive start of the window, epoch ms. */
	from: number;
	/** Exclusive end of the window, epoch ms. */
	to: number;
	/** Bucket width in ms. */
	bucketMs?: number;
	/** Only count this level; `null` counts every level. */
	level?: LogLevel | null;
	/** Group name used for events that carry none. */
	fallbackGroup?: string;
	/**
	 * Count requests instead of lines: lines that share a request id become one
	 * mark, placed where the request started and coloured by its worst level.
	 */
	byRequest?: boolean;
};

/** Level of an event as the chart counts it. */
export function seriesLevelOf(event: LogEventDto): SeriesLevel {
	return effectiveLevel(event) ?? 'unknown';
}

/**
 * Counts events into buckets of one width, per group and level.
 *
 * Events outside the window are ignored, as are events without a usable
 * timestamp: the chart describes exactly the window it is drawn for. With
 * `byRequest`, a request is one mark instead of its lines being many, which is
 * the same thing the archive counts in SQL.
 */
export function bucketEvents(
	events: readonly LogEventDto[],
	options: BucketEventsOptions,
): SeriesPoint[] {
	// A width of zero (or NaN) is a caller mistake, not a request for per-event
	// points, so the default applies.
	const requested = options.bucketMs ?? DEFAULT_BUCKET_MS;
	const bucketMs =
		Number.isFinite(requested) && requested > 0 ? Math.round(requested) : DEFAULT_BUCKET_MS;
	const levelFilter = options.level ?? null;
	const fallbackGroup = options.fallbackGroup ?? '';
	if (options.byRequest === true) {
		return bucketRequests(events, {
			from: options.from,
			to: options.to,
			bucketMs,
			level: levelFilter,
			fallbackGroup,
		});
	}
	const counts = new Map<string, SeriesPoint>();

	for (const event of events) {
		const timestamp = event.timestamp;
		if (!Number.isFinite(timestamp)) continue;
		if (timestamp < options.from || timestamp >= options.to) continue;
		const level = seriesLevelOf(event);
		if (levelFilter !== null && level !== levelFilter) continue;
		const t = Math.floor(timestamp / bucketMs) * bucketMs;
		const group = event.group ?? fallbackGroup;
		const key = `${t}\u0000${group}\u0000${level}`;
		const existing = counts.get(key);
		if (existing === undefined) counts.set(key, { t, group, level, events: 1 });
		else existing.events += 1;
	}

	return [...counts.values()].toSorted((a, b) =>
		a.t === b.t ? a.level.localeCompare(b.level) : a.t - b.t,
	);
}

/** One level's points, ready for a chart series. */
export type LevelSeries = {
	level: SeriesLevel;
	label: string;
	points: SeriesPoint[];
	/** Events in this series. */
	events: number;
};

/**
 * Splits points into one series per level, in severity order.
 *
 * A level with no events is left out, so the legend only names what is drawn.
 */
export function groupByLevel(points: readonly SeriesPoint[]): LevelSeries[] {
	const byLevel = new Map<SeriesLevel, SeriesPoint[]>();
	for (const point of points) {
		const bucket = byLevel.get(point.level);
		if (bucket === undefined) byLevel.set(point.level, [point]);
		else bucket.push(point);
	}
	return LEVEL_ORDER.filter((level) => byLevel.has(level)).map((level) => {
		const levelPoints = (byLevel.get(level) ?? []).toSorted((a, b) => a.t - b.t);
		return {
			level,
			label: LEVEL_LABELS[level],
			points: levelPoints,
			events: levelPoints.reduce((sum, point) => sum + point.events, 0),
		};
	});
}

/**
 * Sums points per bucket across groups and levels.
 *
 * The chart's Y axis counts events in a bucket, so a multi-group view still
 * reads as one profile: one point per bucket with the total.
 */
export function totalPerBucket(points: readonly SeriesPoint[]): { t: number; events: number }[] {
	const totals = new Map<number, number>();
	for (const point of points) totals.set(point.t, (totals.get(point.t) ?? 0) + point.events);
	return [...totals.entries()].map(([t, events]) => ({ t, events })).toSorted((a, b) => a.t - b.t);
}

/** Narrowest brush the app acts on, whatever the window is. */
export const MIN_BRUSH_MS = 30_000;

/** Fraction of the window a brush must stay under to count as a zoom. */
export const MAX_BRUSH_FRACTION = 0.98;

/**
 * True when a brushed range is a deliberate zoom rather than a stray click.
 *
 * A pointer down and up a couple of pixels apart still produces a range (the
 * chart has a minimum selection width), and a double click on empty space
 * selects the whole domain. Acting on either would re-scope the log view to a
 * window with nothing in it, so a brush is only applied when it spans at least
 * two buckets and a floor of {@link MIN_BRUSH_MS}, and is narrower than almost
 * the whole window.
 */
export function isMeaningfulBrush(
	range: { from: number; to: number },
	window: { from: number; to: number },
	bucketMs: number,
): boolean {
	const span = range.to - range.from;
	if (!Number.isFinite(span) || span <= 0) return false;
	const windowSpan = window.to - window.from;
	if (!Number.isFinite(windowSpan) || windowSpan <= 0) return false;
	const floor = Math.max(MIN_BRUSH_MS, bucketMs * 2);
	if (span < floor) return false;
	return span <= windowSpan * MAX_BRUSH_FRACTION;
}

/** One point per identified request, using its observed first/last events in the window. */
export function requestDurations(
	events: readonly LogEventDto[],
	options: BucketEventsOptions,
): SeriesPoint[] {
	const byGroup = new Map<string, LogEventDto[]>();
	for (const event of events) {
		if (
			!Number.isFinite(event.timestamp) ||
			event.timestamp < options.from ||
			event.timestamp > options.to
		)
			continue;
		const group = event.group ?? options.fallbackGroup ?? '';
		const rows = byGroup.get(group) ?? [];
		rows.push(event);
		byGroup.set(group, rows);
	}
	const points: SeriesPoint[] = [];
	for (const [group, rows] of byGroup) {
		for (const request of collectRequests(rows)) {
			if (options.level && request.level !== options.level) continue;
			// Equal timestamps use the last arrival, matching the archive's seq tie-breaker.
			const last = request.events.reduce(
				(latest, entry) => (entry.event.timestamp >= latest.timestamp ? entry.event : latest),
				request.events[0].event,
			);
			points.push({
				t: request.first,
				group,
				level: request.level,
				events: 1,
				requestId: request.id,
				durationMs: request.last - request.first + eventDurationMs(last.message),
			});
		}
	}
	return points.toSorted(
		(a, b) =>
			a.t - b.t ||
			a.group.localeCompare(b.group) ||
			(a.requestId ?? '').localeCompare(b.requestId ?? ''),
	);
}
