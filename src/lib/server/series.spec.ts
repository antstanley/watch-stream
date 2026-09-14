import { describe, expect, test } from 'vitest';
import {
	BUCKET_LADDER,
	GROUP_BY_PARAM_HINT,
	MAX_BUCKET_MS,
	MIN_BUCKET_MS,
	TARGET_BUCKETS,
	buildSeriesResponse,
	chooseBucketMs,
	parseBucketParam,
	parseGroupByParam,
	readSeries,
	summariseGroups,
	summariseLevels,
} from './series';
import type { SeriesPoint } from '$lib/types';
import type { ArchiveSeriesRow } from './archive-sql';
import type { LogArchive } from './archive';

const TS = Date.UTC(2024, 4, 17, 12, 0, 0);
const MINUTE = 60_000;

describe('chooseBucketMs', () => {
	test('keeps the bucket count at or under the target', () => {
		expect(chooseBucketMs(15 * MINUTE)).toBe(10_000);
		expect(chooseBucketMs(60 * MINUTE)).toBe(60_000);
		expect(chooseBucketMs(24 * 60 * MINUTE)).toBe(30 * 60_000);
		expect(chooseBucketMs(5 * 24 * 60 * MINUTE)).toBe(3 * 60 * 60_000);
	});

	test('never returns a bucket wider than the ladder allows', () => {
		for (const span of [MINUTE, 60 * MINUTE, 24 * 60 * MINUTE, 30 * 24 * 60 * MINUTE]) {
			const bucket = chooseBucketMs(span);
			expect(bucket).toBeGreaterThanOrEqual(BUCKET_LADDER[0] as number);
			expect(bucket).toBeLessThanOrEqual(BUCKET_LADDER.at(-1) as number);
		}
	});

	test('scales the bucket down as the target grows and up for wider windows', () => {
		expect(chooseBucketMs(60 * MINUTE, 1000)).toBeLessThanOrEqual(chooseBucketMs(60 * MINUTE, 10));
		expect(chooseBucketMs(7 * 24 * 60 * MINUTE)).toBeGreaterThanOrEqual(
			chooseBucketMs(60 * MINUTE),
		);
		expect(TARGET_BUCKETS).toBeGreaterThan(10);
	});

	test('handles a degenerate window', () => {
		expect(chooseBucketMs(0)).toBe(BUCKET_LADDER[0]);
		expect(chooseBucketMs(-5)).toBe(BUCKET_LADDER[0]);
		expect(chooseBucketMs(Number.NaN)).toBe(BUCKET_LADDER[0]);
	});
});

describe('parseBucketParam', () => {
	test('accepts durations and plain milliseconds', () => {
		expect(parseBucketParam('30s')).toBe(30_000);
		expect(parseBucketParam('5m')).toBe(5 * MINUTE);
		expect(parseBucketParam('2h')).toBe(2 * 60 * MINUTE);
		expect(parseBucketParam('2500')).toBe(2500);
		expect(parseBucketParam(' 30s ')).toBe(30_000);
	});

	test('rejects what it cannot read, so the caller can choose', () => {
		expect(parseBucketParam(null)).toBeNull();
		expect(parseBucketParam('')).toBeNull();
		expect(parseBucketParam('soon')).toBeNull();
		expect(parseBucketParam('0')).toBeNull();
		expect(parseBucketParam('-30s')).toBeNull();
	});

	test('clamps to the supported range', () => {
		expect(parseBucketParam('10ms')).toBe(MIN_BUCKET_MS);
		expect(parseBucketParam('30d')).toBe(MAX_BUCKET_MS);
	});
});

describe('parseGroupByParam', () => {
	test('treats an absent or blank value as the default grouping', () => {
		expect(parseGroupByParam(null)).toBeNull();
		expect(parseGroupByParam(undefined)).toBeNull();
		expect(parseGroupByParam('   ')).toBeNull();
	});

	test('reads the two groupings this app can answer', () => {
		expect(parseGroupByParam('event')).toBe('event');
		expect(parseGroupByParam('request')).toBe('request');
		expect(parseGroupByParam(' Request ')).toBe('request');
	});

	test('reports an unknown grouping instead of ignoring it', () => {
		expect(parseGroupByParam('session')).toBeUndefined();
		expect(parseGroupByParam('requests')).toBeUndefined();
		expect(GROUP_BY_PARAM_HINT).toContain('"event" or "request"');
	});
});

describe('summaries', () => {
	const points: SeriesPoint[] = [
		{ t: TS, group: '/a', level: 'info', events: 5 },
		{ t: TS, group: '/b', level: 'error', events: 2 },
		{ t: TS + 1000, group: '/a', level: 'unknown', events: 3 },
		{ t: TS + 1000, group: '/a', level: 'error', events: 1 },
	];

	test('sums levels in severity order', () => {
		expect(summariseLevels(points)).toEqual([
			{ level: 'error', events: 3 },
			{ level: 'info', events: 5 },
			{ level: 'unknown', events: 3 },
		]);
	});

	test('sums groups, busiest first', () => {
		expect(summariseGroups(points)).toEqual([
			{ group: '/a', events: 9 },
			{ group: '/b', events: 2 },
		]);
	});

	test('omits levels and groups that have no events', () => {
		expect(summariseLevels([])).toEqual([]);
		expect(summariseGroups([])).toEqual([]);
	});
});

describe('buildSeriesResponse', () => {
	test('carries the window, the bucket and the totals', () => {
		const rows: ArchiveSeriesRow[] = [
			{ t: TS, group: '/a', level: 'error', events: 2 },
			{ t: TS, group: '/b', level: 'info', events: 1 },
		];
		const body = buildSeriesResponse({
			from: TS,
			to: TS + 60_000,
			bucketMs: 10_000,
			groupBy: 'event',
			rows,
		});
		expect(body).toMatchObject({
			from: TS,
			to: TS + 60_000,
			bucketMs: 10_000,
			groupBy: 'event',
			totals: { events: 3, points: 2 },
		});
		expect(body.points).toHaveLength(2);
		expect(body.levels).toEqual([
			{ level: 'error', events: 2 },
			{ level: 'info', events: 1 },
		]);
		expect(body.groups.map((entry) => entry.group)).toEqual(['/a', '/b']);
	});

	test('echoes the grouping it was built for', () => {
		const request = buildSeriesResponse({
			from: TS,
			to: TS,
			bucketMs: 1_000,
			groupBy: 'request',
			rows: [{ t: TS, group: '/a', level: 'error', events: 1 }],
		});
		expect(request.groupBy).toBe('request');
		// The empty series carries it too, so the chart never has to guess.
		const empty = buildSeriesResponse({
			from: TS,
			to: TS,
			bucketMs: 1_000,
			groupBy: 'request',
			rows: [],
		});
		expect(empty.groupBy).toBe('request');
		expect(empty.points).toEqual([]);
	});
});

/** Archive double that records the query it was asked for. */
function fakeArchive(rows: ArchiveSeriesRow[], available = true) {
	const calls: unknown[] = [];
	const archive = {
		available,
		async seriesQuery(request: unknown) {
			calls.push(request);
			return available ? rows : [];
		},
	} as unknown as LogArchive;
	return { archive, calls };
}

describe('readSeries', () => {
	test('asks for one bucket width per window and returns the points', async () => {
		const { archive, calls } = fakeArchive([{ t: TS, group: '/a', level: 'warn', events: 4 }]);
		const body = await readSeries({
			archive,
			region: 'af-south-1',
			logGroups: ['/a'],
			from: TS,
			to: TS + 60 * MINUTE,
		});
		expect(calls[0]).toMatchObject({
			region: 'af-south-1',
			logGroups: ['/a'],
			startTime: TS,
			endTime: TS + 60 * MINUTE,
			bucketMs: 60_000,
		});
		expect(body.totals.events).toBe(4);
	});

	test('honours an explicit bucket and the level filter', async () => {
		const { archive, calls } = fakeArchive([]);
		await readSeries({
			archive,
			region: 'af-south-1',
			logGroups: ['/a', '/b'],
			from: TS,
			to: TS + MINUTE,
			levels: ['error'],
			bucketMs: 5_000,
		});
		expect(calls[0]).toMatchObject({ bucketMs: 5_000, levels: ['error'], logGroups: ['/a', '/b'] });
	});

	test('answers an empty series for an unavailable archive', async () => {
		const { archive, calls } = fakeArchive([], false);
		const body = await readSeries({
			archive,
			region: 'af-south-1',
			logGroups: ['/a'],
			from: TS,
			to: TS + MINUTE,
		});
		expect(calls).toEqual([]);
		expect(body.totals).toEqual({ events: 0, points: 0 });
		expect(body.bucketMs).toBeGreaterThan(0);
		// The grouping is answered even when nothing could be counted.
		expect(body.groupBy).toBe('event');
	});

	test('forwards the grouping to the archive and echoes it back', async () => {
		const { archive, calls } = fakeArchive([], false);
		const request = await readSeries({
			archive,
			region: 'af-south-1',
			logGroups: ['/a'],
			from: TS,
			to: TS + MINUTE,
			by: 'request',
		});
		expect(request.groupBy).toBe('request');
		expect(calls).toEqual([]);

		const { archive: live, calls: liveCalls } = fakeArchive([]);
		const body = await readSeries({
			archive: live,
			region: 'af-south-1',
			logGroups: ['/a'],
			from: TS,
			to: TS + MINUTE,
			by: 'request',
		});
		expect(liveCalls[0]).toMatchObject({ by: 'request' });
		expect(body.groupBy).toBe('request');

		// An absent grouping stays the event count this app has always charted.
		const { archive: defaults, calls: defaultCalls } = fakeArchive([]);
		const plain = await readSeries({
			archive: defaults,
			region: 'af-south-1',
			logGroups: ['/a'],
			from: TS,
			to: TS + MINUTE,
		});
		expect(defaultCalls[0]).toMatchObject({ by: 'event' });
		expect(plain.groupBy).toBe('event');
	});
});
