import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { LogArchive, loadDuckDbDriver } from './archive';
import { readSeries } from './series';
import { requestDurations } from '$lib/series-buckets';
import type { LogEventDto } from '$lib/types';

const installed = await loadDuckDbDriver().then(
	() => true,
	() => false,
);
test.skipIf(!installed)(
	'archive duration points match the browser, including last-event duration and severity',
	async () => {
		const dir = mkdtempSync(join(tmpdir(), 'watch-tail-duration-'));
		const archive = await LogArchive.open({ path: join(dir, 'archive.duckdb') });
		const events: LogEventDto[] = [
			{
				id: 'last',
				timestamp: 1400,
				message: 'INFO {"requestId":"abcd","duration":25.5,"level":"info"}',
				group: '/a',
			},
			{
				id: 'first',
				timestamp: 1000,
				message: '{"requestId":"abcd","duration":9999,"level":"error"}',
				group: '/a',
			},
			{
				id: 'single',
				timestamp: 1200,
				message: '{"requestId":"single","durationMs":17}',
				group: '/a',
			},
			{ id: 'no-id', timestamp: 1300, message: '{"duration":100}', group: '/a' },
			{
				id: 'other-group',
				timestamp: 1050,
				message: '{"requestId":"abcd","duration":20}',
				group: '/b',
			},
			{
				id: 'tie-first',
				timestamp: 1600,
				message: '{"requestId":"tied","duration":12}',
				group: '/b',
			},
			{
				id: 'tie-last',
				timestamp: 1600,
				message: '{"requestId":"tied","duration":4}',
				group: '/b',
			},
		];
		try {
			for (const group of ['/a', '/b'])
				await archive.record(
					'eu-west-1',
					group,
					events.filter((e) => e.group === group),
				);
			const input = {
				archive,
				region: 'eu-west-1',
				logGroups: ['/a', '/b'],
				from: 900,
				to: 2000,
				metric: 'duration' as const,
			};
			const series = await readSeries(input);
			expect(archive.error).toBeNull();
			expect(series.groupBy).toBe('request');
			expect(series.points).toEqual(requestDurations(events, { from: 900, to: 2000 }));
			expect(series.points.map((p) => p.durationMs)).toEqual([425.5, 20, 17, 4]);
			expect((await readSeries({ ...input, levels: ['error'] })).points).toEqual([
				series.points[0],
			]);
			const count = await readSeries({ ...input, metric: 'count', by: 'event' });
			expect(count.totals.events).toBe(events.length);
			expect(count.points.every((p) => p.durationMs === undefined)).toBe(true);
		} finally {
			await archive.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
