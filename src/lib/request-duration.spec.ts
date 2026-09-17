import { describe, expect, test } from 'vitest';
import { eventDurationMs } from './request-duration';
import { requestDurations } from './series-buckets';
import type { LogEventDto } from './types';

function event(
	timestamp: number,
	message: string,
	group = '/a',
	requestId: string | null = 'request-1',
): LogEventDto {
	return { id: null, timestamp, message, group, requestId };
}

describe('request duration', () => {
	test('uses the last timestamp plus its explicit duration, regardless of arrival order', () => {
		const points = requestDurations(
			[event(1400, '{"duration":25.5}'), event(1000, '{"duration":9999}'), event(1200, '{}')],
			{ from: 0, to: 2000 },
		);
		expect(points).toEqual([
			{
				t: 1000,
				durationMs: 425.5,
				requestId: 'request-1',
				group: '/a',
				events: 1,
				level: 'unknown',
			},
		]);
	});

	test('isolates identical IDs across groups and filters whole requests by worst severity', () => {
		const events = [
			event(1000, '{"level":"error"}'),
			event(1100, '{}'),
			event(1050, '{"durationMs":7}', '/b'),
		];
		expect(requestDurations(events, { from: 0, to: 2000 }).map((p) => p.durationMs)).toEqual([
			100, 7,
		]);
		expect(requestDurations(events, { from: 0, to: 2000, level: 'error' })).toMatchObject([
			{ t: 1000, durationMs: 100, level: 'error' },
		]);
	});

	test('handles single events, missing IDs, equal timestamps, invalid timestamps and window edges', () => {
		const events = [
			event(NaN, '{}'),
			event(900, '{}'),
			event(1000, '{"duration":999}'),
			event(1000, '{"duration":4}'),
			event(1500, '{}', '/b', null),
			event(2001, '{"duration":55}'),
		];
		expect(requestDurations(events, { from: 1000, to: 2000 })).toMatchObject([
			{ t: 1000, durationMs: 4 },
		]);
		expect(requestDurations([event(1000, '{}')], { from: 1000, to: 1000 })[0].durationMs).toBe(0);
	});

	test.each([
		['{"duration":12.5}', 12.5],
		['INFO {"duration":"42"}', 42],
		['{"durationMs":18}', 18],
		['{"duration":0,"durationMs":18}', 0],
		['{"duration":-1}', 0],
		['{"duration":"NaN"}', 0],
		['{"duration":"1e999"}', 0],
		['{"duration":true}', 0],
		['{"duration":null}', 0],
		['{"duration":""}', 0],
		['{"duration":"15ms"}', 0],
		['[12]', 0],
		['plain line', 0],
	])('reads a duration from %s', (message, expected) => {
		expect(eventDurationMs(message)).toBe(expected);
	});
});
