import { describe, expect, it } from 'vitest';
import { selectedChartEvents, type ChartSelection } from './chart-selection';
import { bucketRequests, requestRows } from './request-groups';
import type { LogEventDto } from './types';

const lines: LogEventDto[] = [
	{ id: 'a', timestamp: 1000, group: 'app', requestId: 'one', level: 'info', message: 'start' },
	{ id: 'b', timestamp: 3000, group: 'app', requestId: 'one', level: 'error', message: 'end' },
	{
		id: 'c',
		timestamp: 1000,
		group: 'other',
		requestId: 'one',
		level: 'error',
		message: 'other group',
	},
	{ id: 'd', timestamp: 1500, group: 'app', requestId: null, level: 'error', message: 'loose' },
	{ id: 'e', timestamp: 2000, group: 'app', requestId: null, level: 'error', message: 'boundary' },
];
const selection: ChartSelection = {
	point: { t: 1000, group: 'app', level: 'error', events: 2 },
	bucketMs: 1000,
	byRequest: true,
	fallbackGroup: '',
};
const ids = (choice: ChartSelection) =>
	[...selectedChartEvents(lines, choice)].map((e) => e.id).toSorted();

describe('chart selection', () => {
	it('selects whole requests by their first timestamp and worst level, plus loose events', () => {
		expect(ids(selection)).toEqual(['a', 'b', 'd']);
	});
	it('selects individual events in an exclusive-ended bucket without crossing groups', () => {
		expect(ids({ ...selection, byRequest: false })).toEqual(['d']);
	});
	it('selects a duration request by ID and group regardless of event levels', () => {
		expect(ids({ ...selection, point: { ...selection.point, requestId: 'one' } })).toEqual([
			'a',
			'b',
		]);
	});
	it('keeps equal request IDs in different groups separate in rows and counts', () => {
		const rows = requestRows(lines).filter((row) => row.kind === 'request');
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.key)).size).toBe(2);
		expect(bucketRequests(lines, { from: 0, to: 5000, bucketMs: 1000 })).toContainEqual({
			t: 1000,
			group: 'other',
			level: 'error',
			events: 1,
		});
	});
});
