/**
 * Request ids: detection, grouping, and the bucketing the chart uses for a
 * CloudWatch view that has no server-side aggregate.
 */
import { describe, expect, it } from 'vitest';
import {
	bucketRequests,
	collectRequests,
	hasRequestId,
	requestIdOf,
	requestRows,
} from './request-groups';
import type { LogEventDto } from './types';

/** Builds an event, one second after the previous one. */
function event(index: number, message: string, extra: Partial<LogEventDto> = {}): LogEventDto {
	return {
		id: `id-${index}`,
		timestamp: 1_700_000_000_000 + index * 1_000,
		message,
		...extra,
	};
}

describe('requestIdOf', () => {
	it('uses the id the server detected', () => {
		expect(requestIdOf(event(0, 'plain line', { requestId: 'abc-123' }))).toBe('abc-123');
	});

	it('treats an explicit null as "this line has no request", without re-reading the text', () => {
		expect(requestIdOf(event(0, '{"requestId":"abc-123"}', { requestId: null }))).toBeNull();
	});

	it('detects the id itself when the event carries no verdict', () => {
		expect(requestIdOf(event(0, '{"requestId":"abc-123"}'))).toBe('abc-123');
	});

	it('reports that a line belongs to no request', () => {
		expect(hasRequestId(event(0, 'nothing to see'))).toBe(false);
		expect(hasRequestId(event(0, '{"requestId":"abc-123"}'))).toBe(true);
	});
});

describe('collectRequests', () => {
	it('groups interleaved lines that share a request id', () => {
		const events = [
			event(0, '{"requestId":"req-a","msg":"start"}'),
			event(1, '{"requestId":"req-b","msg":"other"}'),
			event(2, '{"requestId":"req-a","msg":"finish"}'),
		];
		const groups = collectRequests(events);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.id).toBe('req-a');
		expect(groups[0]?.events.map((entry) => entry.index)).toEqual([0, 2]);
		expect(groups[1]?.id).toBe('req-b');
	});

	it('takes the most critical level of the group and the span of its lines', () => {
		const events = [
			event(0, '{"requestId":"req-a","level":"info"}'),
			event(1, '{"requestId":"req-a","level":"warn"}'),
		];
		const [group] = collectRequests(events);
		expect(group?.level).toBe('warn');
		expect(group?.first).toBe(events[0]?.timestamp);
		expect(group?.last).toBe(events[1]?.timestamp);
	});

	it('reports unknown when no line of the group has a level', () => {
		const [group] = collectRequests([event(0, '{"requestId":"req-a","msg":"hm"}')]);
		expect(group?.level).toBe('unknown');
	});

	it('ignores lines without a request id', () => {
		expect(collectRequests([event(0, 'plain'), event(1, '{"requestId":"req-a"}')])).toHaveLength(1);
	});
});

describe('requestRows', () => {
	it('places a request where its first line appeared and hides its later lines', () => {
		const rows = requestRows([
			event(0, '{"requestId":"req-a"}'),
			event(1, '{"requestId":"req-b"}'),
			event(2, '{"requestId":"req-a"}'),
		]);
		expect(rows.map((row) => row.kind)).toEqual(['request', 'request']);
		expect(rows[0]?.key).toBe('req:["","req-a"]');
		expect(rows[0]?.kind === 'request' ? rows[0].request.events.length : 0).toBe(2);
	});

	it('keeps ungrouped lines in their own position', () => {
		const rows = requestRows([
			event(0, 'plain before'),
			event(1, '{"requestId":"req-a"}'),
			event(2, 'plain after'),
		]);
		expect(rows.map((row) => row.kind)).toEqual(['line', 'request', 'line']);
		expect(rows[0]?.kind === 'line' ? rows[0].index : -1).toBe(0);
		expect(rows[2]?.kind === 'line' ? rows[2].index : -1).toBe(2);
	});

	it('keeps an id shared across log groups separate', () => {
		const rows = requestRows([
			event(0, '{"requestId":"req-a"}', { group: '/aws/lambda/api' }),
			event(1, '{"requestId":"req-a"}', { group: '/aws/apigateway/api' }),
		]);
		expect(rows).toHaveLength(2);
	});
});

describe('bucketRequests', () => {
	const window = { from: 1_700_000_000_000, to: 1_700_000_100_000, bucketMs: 10_000 };

	it('counts each request once, in the bucket it started in', () => {
		const points = bucketRequests(
			[
				event(0, '{"requestId":"req-a","level":"info"}'),
				event(1, '{"requestId":"req-a","level":"error"}'),
				event(2, '{"requestId":"req-b","level":"info"}'),
			],
			window,
		);
		expect(points).toEqual([
			{ t: 1_700_000_000_000, group: '', level: 'error', events: 1 },
			{ t: 1_700_000_000_000, group: '', level: 'info', events: 1 },
		]);
		expect(points.reduce((sum, point) => sum + point.events, 0)).toBe(2);
	});

	it('keeps a request that spans buckets as one mark', () => {
		const points = bucketRequests(
			[event(0, '{"requestId":"req-a"}'), event(30, '{"requestId":"req-a"}')],
			window,
		);
		expect(points).toHaveLength(1);
		expect(points[0]?.t).toBe(1_700_000_000_000);
	});

	it('filters by the most critical level of the request', () => {
		const events = [
			event(0, '{"requestId":"req-a","level":"info"}'),
			event(1, '{"requestId":"req-a","level":"error"}'),
			event(2, '{"requestId":"req-b","level":"info"}'),
		];
		const errors = bucketRequests(events, { ...window, level: 'error' });
		expect(errors).toHaveLength(1);
		expect(errors[0]?.events).toBe(1);
		expect(bucketRequests(events, { ...window, level: 'warn' })).toEqual([]);
	});

	it('counts ungrouped lines as their own marks', () => {
		const points = bucketRequests([event(0, 'plain'), event(1, 'plain too')], window);
		expect(points.reduce((sum, point) => sum + point.events, 0)).toBe(2);
	});

	it('ignores a request that started before the window', () => {
		const points = bucketRequests(
			[event(-60, '{"requestId":"req-old"}'), event(1, '{"requestId":"req-new"}')],
			window,
		);
		expect(points).toHaveLength(1);
		expect(points[0]?.t).toBe(1_700_000_000_000);
	});

	it('names the group of the first line, falling back when the event has none', () => {
		const grouped = bucketRequests(
			[event(0, '{"requestId":"req-a"}', { group: '/aws/lambda/api' })],
			window,
		);
		expect(grouped[0]?.group).toBe('/aws/lambda/api');
		const fallback = bucketRequests([event(0, '{"requestId":"req-a"}')], {
			...window,
			fallbackGroup: '/fallback',
		});
		expect(fallback[0]?.group).toBe('/fallback');
	});

	it('treats a missing bucket width as a minute', () => {
		const points = bucketRequests([event(0, '{"requestId":"req-a"}')], {
			from: window.from,
			to: window.to,
			bucketMs: 0,
		});
		expect(points[0]?.t).toBe(Math.floor(1_700_000_000_000 / 60_000) * 60_000);
	});
});
