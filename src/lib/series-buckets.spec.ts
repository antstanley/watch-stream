import { describe, expect, test } from 'vitest';
import {
	DEFAULT_BUCKET_MS,
	MAX_BRUSH_FRACTION,
	MIN_BRUSH_MS,
	isMeaningfulBrush,
	LEVEL_LABELS,
	LEVEL_ORDER,
	bucketEvents,
	groupByLevel,
	seriesLevelOf,
	totalPerBucket,
} from './series-buckets';
import type { LogEventDto, SeriesPoint } from './types';

const BASE = Date.UTC(2024, 4, 17, 12, 0, 0);
const MINUTE = 60_000;

function event(timestamp: number, message: string, extra: Partial<LogEventDto> = {}): LogEventDto {
	return { id: `e-${timestamp}-${message}`, timestamp, message, ...extra };
}

describe('seriesLevelOf', () => {
	test('prefers the detected level and reports no level as unknown', () => {
		expect(seriesLevelOf(event(BASE, 'anything', { level: 'warn' }))).toBe('warn');
		expect(seriesLevelOf(event(BASE, 'ERROR boom'))).toBe('error');
		expect(seriesLevelOf(event(BASE, 'plain line'))).toBe('unknown');
	});
});

describe('bucketEvents', () => {
	test('counts events per bucket, group and level', () => {
		const points = bucketEvents(
			[
				event(BASE + 1_000, 'ERROR one', { group: '/a' }),
				event(BASE + 2_000, 'ERROR two', { group: '/a' }),
				// A plain 'INFO' word is not a signal the detector trusts, so the level
				// is declared here the way a structured log would.
				event(BASE + 3_000, 'ok', { group: '/a', level: 'info' }),
				event(BASE + 61_000, 'ERROR later', { group: '/b' }),
			],
			{ from: BASE, to: BASE + 120_000, bucketMs: MINUTE },
		);
		expect(points).toEqual([
			{ t: BASE, group: '/a', level: 'error', events: 2 },
			{ t: BASE, group: '/a', level: 'info', events: 1 },
			{ t: BASE + MINUTE, group: '/b', level: 'error', events: 1 },
		]);
	});

	test('ignores events outside the window and unusable timestamps', () => {
		const points = bucketEvents(
			[
				event(BASE - 1, 'before'),
				event(BASE, 'at the start'),
				event(BASE + 120_000, 'at the end'),
				{ id: 'x', timestamp: Number.NaN, message: 'no time' },
			],
			{ from: BASE, to: BASE + 120_000, bucketMs: MINUTE },
		);
		expect(points).toEqual([{ t: BASE, group: '', level: 'unknown', events: 1 }]);
	});

	test('honours a level filter, which is how the chips narrow the chart', () => {
		const events = [event(BASE, 'ERROR one'), event(BASE, 'WARN two'), event(BASE, 'INFO three')];
		expect(bucketEvents(events, { from: BASE, to: BASE + MINUTE, level: 'error' })).toEqual([
			{ t: BASE, group: '', level: 'error', events: 1 },
		]);
		expect(bucketEvents(events, { from: BASE, to: BASE + MINUTE, level: null })).toHaveLength(3);
	});

	test('uses the fallback group for events without one', () => {
		const points = bucketEvents([event(BASE, 'hello')], {
			from: BASE,
			to: BASE + MINUTE,
			fallbackGroup: '/fallback',
		});
		expect(points[0]?.group).toBe('/fallback');
	});

	test('defaults to a one minute bucket, and falls back to it for a silly width', () => {
		expect(DEFAULT_BUCKET_MS).toBe(MINUTE);
		for (const bucketMs of [0, -5, Number.NaN]) {
			const points = bucketEvents([event(BASE + 30_000, 'hello')], {
				from: BASE,
				to: BASE + MINUTE,
				bucketMs,
			});
			expect(points[0]?.t).toBe(BASE);
		}
	});

	test('honours a finer bucket when one is asked for', () => {
		const points = bucketEvents([event(BASE + 30_000, 'hello')], {
			from: BASE,
			to: BASE + MINUTE,
			bucketMs: 10_000,
		});
		expect(points[0]?.t).toBe(BASE + 30_000);
	});

	test('returns nothing for no events', () => {
		expect(bucketEvents([], { from: BASE, to: BASE + MINUTE })).toEqual([]);
	});
});

describe('groupByLevel', () => {
	const points: SeriesPoint[] = [
		{ t: BASE + MINUTE, group: '/a', level: 'error', events: 2 },
		{ t: BASE, group: '/a', level: 'info', events: 1 },
		{ t: BASE, group: '/b', level: 'error', events: 1 },
		{ t: BASE, group: '/a', level: 'unknown', events: 4 },
	];

	test('splits into one series per level, in severity order', () => {
		const series = groupByLevel(points);
		expect(series.map((entry) => entry.level)).toEqual(['error', 'info', 'unknown']);
		expect(series[0]).toMatchObject({ label: 'Error', events: 3 });
		expect(series[0]?.points.map((point) => point.t)).toEqual([BASE, BASE + MINUTE]);
	});

	test('labels every level it can report', () => {
		expect(LEVEL_ORDER).toEqual(['error', 'warn', 'info', 'debug', 'unknown']);
		for (const level of LEVEL_ORDER) expect(LEVEL_LABELS[level]).toBeTruthy();
	});

	test('skips levels with no events', () => {
		expect(groupByLevel(points).map((entry) => entry.level)).not.toContain('debug');
		expect(groupByLevel([])).toEqual([]);
	});
});

describe('totalPerBucket', () => {
	test('sums every group and level into one profile', () => {
		const totals = totalPerBucket([
			{ t: BASE, group: '/a', level: 'error', events: 2 },
			{ t: BASE, group: '/b', level: 'info', events: 3 },
			{ t: BASE + MINUTE, group: '/a', level: 'warn', events: 1 },
		]);
		expect(totals).toEqual([
			{ t: BASE, events: 5 },
			{ t: BASE + MINUTE, events: 1 },
		]);
	});

	test('returns nothing for no points', () => {
		expect(totalPerBucket([])).toEqual([]);
	});
});

describe('isMeaningfulBrush', () => {
	const window = { from: BASE, to: BASE + 60 * MINUTE };

	test('accepts a deliberate zoom into part of the window', () => {
		expect(
			isMeaningfulBrush({ from: BASE + 10 * MINUTE, to: BASE + 30 * MINUTE }, window, MINUTE),
		).toBe(true);
	});

	test('rejects the few pixels a click drags', () => {
		// layerchart turns a small drag into a range at its minimum width, which is
		// what made a click re-scope the log view.
		expect(isMeaningfulBrush({ from: BASE, to: BASE + 30_000 }, window, MINUTE)).toBe(false);
		expect(isMeaningfulBrush({ from: BASE, to: BASE + 1 }, window, MINUTE)).toBe(false);
		expect(isMeaningfulBrush({ from: BASE, to: BASE }, window, MINUTE)).toBe(false);
	});

	test('needs at least two buckets, whatever the floor is', () => {
		const wide = { from: BASE, to: BASE + 60 * MINUTE };
		// Buckets are two minutes wide here, so a one minute brush is too fine to be
		// a zoom into a bucket.
		expect(isMeaningfulBrush({ from: BASE, to: BASE + MINUTE }, wide, 2 * MINUTE)).toBe(false);
		expect(isMeaningfulBrush({ from: BASE, to: BASE + 4 * MINUTE }, wide, 2 * MINUTE)).toBe(true);
	});

	test('rejects a selection of the whole window, which a double click produces', () => {
		expect(isMeaningfulBrush(window, window, MINUTE)).toBe(false);
		expect(
			isMeaningfulBrush(
				{ from: window.from, to: window.from + 60 * MINUTE * 0.99 },
				window,
				MINUTE,
			),
		).toBe(false);
		expect(
			isMeaningfulBrush(
				{ from: window.from, to: window.from + 60 * MINUTE * MAX_BRUSH_FRACTION },
				window,
				MINUTE,
			),
		).toBe(true);
	});

	test('has a floor that ignores a click-sized drag', () => {
		const wide = { from: BASE, to: BASE + 60 * MINUTE };
		// With 10-second buckets the floor is the constant itself.
		expect(MIN_BRUSH_MS).toBe(30_000);
		expect(isMeaningfulBrush({ from: BASE, to: BASE + MIN_BRUSH_MS - 1 }, wide, 10_000)).toBe(
			false,
		);
		expect(isMeaningfulBrush({ from: BASE, to: BASE + MIN_BRUSH_MS }, wide, 10_000)).toBe(true);
		// With minute buckets, two buckets are the floor, which is wider.
		expect(isMeaningfulBrush({ from: BASE, to: BASE + MIN_BRUSH_MS }, wide, MINUTE)).toBe(false);
		expect(isMeaningfulBrush({ from: BASE, to: BASE + 2 * MINUTE }, wide, MINUTE)).toBe(true);
	});

	test('refuses nonsense input', () => {
		expect(isMeaningfulBrush({ from: BASE + 10, to: BASE }, window, MINUTE)).toBe(false);
		expect(isMeaningfulBrush({ from: BASE, to: Number.NaN }, window, MINUTE)).toBe(false);
		expect(
			isMeaningfulBrush({ from: BASE, to: BASE + 10 * MINUTE }, { from: BASE, to: BASE }, MINUTE),
		).toBe(false);
	});
});

describe('bucketEvents with request grouping', () => {
	const window = { from: 1_700_000_000_000, to: 1_700_000_600_000 };

	test('counts one mark per request instead of one per line', () => {
		const events = [
			{ id: '1', timestamp: window.from, message: '{"requestId":"req-a","level":"info"}' },
			{ id: '2', timestamp: window.from + 1_000, message: '{"requestId":"req-a","level":"error"}' },
			{ id: '3', timestamp: window.from + 2_000, message: '{"requestId":"req-b","level":"info"}' },
		] as LogEventDto[];
		const points = bucketEvents(events, { ...window, bucketMs: 60_000, byRequest: true });
		expect(points.reduce((sum, point) => sum + point.events, 0)).toBe(2);
		expect(points.map((point) => point.level).toSorted()).toEqual(['error', 'info']);
	});

	test('counts lines one by one when grouping is off', () => {
		const events = [
			{ id: '1', timestamp: window.from, message: '{"requestId":"req-a","level":"info"}' },
			{ id: '2', timestamp: window.from + 1_000, message: '{"requestId":"req-a","level":"info"}' },
		] as LogEventDto[];
		expect(bucketEvents(events, { ...window, bucketMs: 60_000, byRequest: false })[0]?.events).toBe(
			2,
		);
	});
});
