/**
 * Chart series: event counts per time bucket, per group and level.
 *
 * The archive is the only source with a server-side aggregate, because DuckDB
 * can count a whole window in one statement. A live CloudWatch view has no such
 * API - `FilterLogEvents` returns events, not counts - so the client buckets the
 * events it has already loaded instead, and both paths feed the same chart.
 */
import type { LogLevel } from '$lib/log-buffer';
import type { LogArchive } from './archive';
import type { ArchiveSeriesRow } from './archive-sql';
import { parseDurationMs } from './filter';
import type {
	SeriesGroupTotal,
	SeriesLevel,
	SeriesLevelTotal,
	SeriesPoint,
	SeriesResponse,
} from '$lib/types';

/** Message used when a caller asks for a series the app cannot aggregate. */
export const SERIES_SOURCE_HINT =
	'Series are only aggregated for source=archive; a live CloudWatch view buckets the events it has loaded';

/** Bucket widths offered to an automatic window, smallest first. */
export const BUCKET_LADDER: readonly number[] = [
	1_000,
	5_000,
	10_000,
	30_000,
	60_000,
	5 * 60_000,
	15 * 60_000,
	30 * 60_000,
	60 * 60_000,
	3 * 60 * 60_000,
	6 * 60 * 60_000,
	12 * 60 * 60_000,
	24 * 60 * 60_000,
	7 * 24 * 60 * 60_000,
];

/** Buckets an automatically sized window aims to stay under. */
export const TARGET_BUCKETS = 90;

/** Bounds on an explicit bucket width. */
export const MIN_BUCKET_MS = 1_000;
export const MAX_BUCKET_MS = 7 * 24 * 60 * 60_000;

/**
 * Picks a bucket width for a window.
 *
 * The smallest ladder step that keeps the number of buckets at or below
 * {@link TARGET_BUCKETS} wins, so a fifteen-minute window is bucketed in seconds
 * and a week in hours, and the axis never renders thousands of ticks.
 */
export function chooseBucketMs(windowMs: number, target = TARGET_BUCKETS): number {
	const span = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000;
	const wanted = Math.max(1, Math.round(target));
	for (const step of BUCKET_LADDER) {
		if (span / step <= wanted) return step;
	}
	return BUCKET_LADDER.at(-1) as number;
}

/**
 * Reads an explicit `bucket` parameter.
 *
 * Accepts a duration (`30s`, `5m`, `2h`) or plain milliseconds, and returns
 * `null` for anything unusable so the caller falls back to an automatic width.
 * The result is clamped to {@link MIN_BUCKET_MS}..{@link MAX_BUCKET_MS}.
 */
export function parseBucketParam(value: string | null | undefined): number | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	const ms = /^\d+$/.test(trimmed) ? Number(trimmed) : parseDurationMs(trimmed);
	if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
	return Math.min(Math.max(Math.round(ms), MIN_BUCKET_MS), MAX_BUCKET_MS);
}

/** Sums rows per level, in a fixed severity order. */
export function summariseLevels(points: readonly SeriesPoint[]): SeriesLevelTotal[] {
	const order: SeriesLevel[] = ['error', 'warn', 'info', 'debug', 'unknown'];
	const totals = new Map<SeriesLevel, number>();
	for (const point of points)
		totals.set(point.level, (totals.get(point.level) ?? 0) + point.events);
	return order
		.filter((level) => totals.has(level))
		.map((level) => ({ level, events: totals.get(level) as number }));
}

/** Sums rows per group, busiest first. */
export function summariseGroups(points: readonly SeriesPoint[]): SeriesGroupTotal[] {
	const totals = new Map<string, number>();
	for (const point of points)
		totals.set(point.group, (totals.get(point.group) ?? 0) + point.events);
	return [...totals.entries()]
		.map(([group, events]) => ({ group, events }))
		.toSorted((a, b) =>
			b.events === a.events ? a.group.localeCompare(b.group) : b.events - a.events,
		);
}

/** Builds the response body from raw bucket rows. */
export function buildSeriesResponse(input: {
	from: number;
	to: number;
	bucketMs: number;
	rows: readonly ArchiveSeriesRow[];
}): SeriesResponse {
	const points: SeriesPoint[] = input.rows.map((row) => ({
		t: row.t,
		group: row.group,
		level: row.level,
		events: row.events,
	}));
	return {
		from: input.from,
		to: input.to,
		bucketMs: input.bucketMs,
		levels: summariseLevels(points),
		groups: summariseGroups(points),
		points,
		totals: {
			events: points.reduce((sum, point) => sum + point.events, 0),
			points: points.length,
		},
	};
}

/**
 * Reads the archived counts for a window.
 *
 * An unavailable archive answers an empty series rather than an error, so the
 * chart can show "nothing archived yet" instead of a failure.
 */
export async function readSeries(input: {
	archive: LogArchive;
	region: string;
	logGroups: readonly string[];
	from: number;
	to: number;
	levels?: readonly LogLevel[] | null;
	bucketMs?: number | null;
}): Promise<SeriesResponse> {
	const bucketMs = input.bucketMs ?? chooseBucketMs(input.to - input.from);
	const empty = buildSeriesResponse({ from: input.from, to: input.to, bucketMs, rows: [] });
	if (!input.archive.available) return empty;
	const rows = await input.archive.seriesQuery({
		region: input.region,
		logGroups: input.logGroups,
		startTime: input.from,
		endTime: input.to,
		bucketMs,
		levels: input.levels ?? null,
	});
	return buildSeriesResponse({ from: input.from, to: input.to, bucketMs, rows });
}
