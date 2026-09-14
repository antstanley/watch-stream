import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as ArchiveServer from '$lib/server/archive';
import { GET } from './+server';

const state = vi.hoisted(() => ({
	available: true,
	rows: [] as { t: number; group: string; level: string; events: number }[],
	calls: [] as Record<string, unknown>[],
}));

const envState = vi.hoisted(() => ({
	current: { AWS_REGION: 'eu-west-1' } as Record<string, string>,
}));
vi.mock('$lib/server/env', () => ({ readEnv: () => envState.current }));
vi.mock('$lib/server/archive', async (importOriginal) => {
	const actual = await importOriginal<typeof ArchiveServer>();
	return {
		...actual,
		getArchive: async () => ({
			available: state.available,
			error: null,
			async seriesQuery(request: Record<string, unknown>) {
				state.calls.push(request);
				return state.available ? state.rows : [];
			},
		}),
	};
});

const TS = Date.UTC(2024, 4, 17, 12, 0, 0);

function event(query: Record<string, string>): { url: URL; request: Request } {
	const url = new URL('http://localhost/api/series');
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	return { url, request: new Request(url) };
}

async function errorOf(response: Response): Promise<{ code?: string }> {
	return (await response.json()) as { code?: string };
}

describe('GET /api/series', () => {
	beforeEach(() => {
		envState.current = { AWS_REGION: 'eu-west-1' };
		state.available = true;
		state.rows = [];
		state.calls = [];
	});

	test('answers bucketed counts for the archive', async () => {
		state.rows = [
			{ t: TS, group: '/aws/lambda/api', level: 'error', events: 2 },
			{ t: TS, group: '/aws/lambda/api', level: 'info', events: 3 },
		];
		const response = await GET(
			event({
				source: 'archive',
				region: 'af-south-1',
				group: '/aws/lambda/api',
				range: '1h',
			}) as never,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			points: unknown[];
			levels: { level: string; events: number }[];
			totals: { events: number };
			bucketMs: number;
		};
		expect(body.totals.events).toBe(5);
		expect(body.points).toHaveLength(2);
		expect(body.levels[0]).toEqual({ level: 'error', events: 2 });
		expect(state.calls[0]).toMatchObject({
			region: 'af-south-1',
			logGroups: ['/aws/lambda/api'],
			bucketMs: 60_000,
		});
	});

	test('accepts several groups and a level filter', async () => {
		const response = await GET(
			event({
				source: 'archive',
				region: 'af-south-1',
				groups: '/a,/b,/c',
				level: 'error,warn',
				from: String(TS),
				to: String(TS + 60_000),
				bucket: '5s',
			}) as never,
		);
		expect(response.status).toBe(200);
		expect(state.calls[0]).toMatchObject({
			logGroups: ['/a', '/b', '/c'],
			levels: ['error', 'warn'],
			bucketMs: 5_000,
		});
	});

	test('counts one mark per request when asked, and says so in the answer', async () => {
		const response = await GET(
			event({
				source: 'archive',
				region: 'af-south-1',
				group: '/a',
				range: '15m',
				by: 'request',
			}) as never,
		);
		expect(response.status).toBe(200);
		expect(state.calls[0]).toMatchObject({ by: 'request' });
		expect((await response.json()) as { groupBy: string }).toMatchObject({ groupBy: 'request' });
	});

	test('defaults to one mark per event', async () => {
		const response = await GET(
			event({ source: 'archive', region: 'af-south-1', group: '/a', range: '15m' }) as never,
		);
		expect(response.status).toBe(200);
		// The default is spelled out, so the archive never has to guess either.
		expect(state.calls[0]).toMatchObject({ by: 'event' });
		expect((await response.json()) as { groupBy: string }).toMatchObject({ groupBy: 'event' });
	});

	test('does not clamp an old window to 14 days', async () => {
		const longAgo = TS - 60 * 24 * 60 * 60 * 1000;
		const response = await GET(
			event({
				source: 'archive',
				region: 'af-south-1',
				group: '/a',
				from: String(longAgo),
				to: String(longAgo + 60_000),
			}) as never,
		);
		expect(response.status).toBe(200);
		// The archive holds what CloudWatch has already forgotten.
		expect(state.calls[0]).toMatchObject({ startTime: longAgo });
		const body = (await response.json()) as { from: number };
		expect(body.from).toBe(longAgo);
	});

	test('rejects a live source, because CloudWatch has no aggregate', async () => {
		const response = await GET(event({ group: '/a', region: 'af-south-1' }) as never);
		expect(response.status).toBe(400);
		expect(await errorOf(response)).toMatchObject({ code: 'unsupported-source' });
		expect(state.calls).toEqual([]);
	});

	test('rejects input it cannot use', async () => {
		const missingGroup = await GET(event({ source: 'archive', region: 'af-south-1' }) as never);
		expect(missingGroup.status).toBe(400);
		expect(await errorOf(missingGroup)).toMatchObject({ code: 'missing-group' });

		const badLevel = await GET(
			event({ source: 'archive', region: 'af-south-1', group: '/a', level: 'shouty' }) as never,
		);
		expect(badLevel.status).toBe(400);
		expect(await errorOf(badLevel)).toMatchObject({ code: 'invalid-level' });

		const badRegion = await GET(
			event({ source: 'archive', group: '/a', region: 'not a region!' }) as never,
		);
		expect(badRegion.status).toBe(400);
		expect(await errorOf(badRegion)).toMatchObject({ code: 'invalid-region' });

		const badSource = await GET(event({ source: 'duckdb', group: '/a' }) as never);
		expect(badSource.status).toBe(400);
		expect(await errorOf(badSource)).toMatchObject({ code: 'invalid-source' });

		const badBy = await GET(
			event({ source: 'archive', region: 'af-south-1', group: '/a', by: 'session' }) as never,
		);
		expect(badBy.status).toBe(400);
		expect(await errorOf(badBy)).toMatchObject({ code: 'invalid-group-by' });
		expect(state.calls).toEqual([]);
	});

	test('requires a region, because archived rows are stored per region', async () => {
		envState.current = {};
		const response = await GET(event({ source: 'archive', group: '/a' }) as never);
		expect(response.status).toBe(400);
		expect(await errorOf(response)).toMatchObject({ code: 'missing-region-param' });
		expect(state.calls).toEqual([]);
	});

	test('answers an empty series when the archive is unavailable', async () => {
		state.available = false;
		const response = await GET(
			event({ source: 'archive', region: 'af-south-1', group: '/a', range: '15m' }) as never,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { points: unknown[]; totals: { events: number } };
		expect(body.points).toEqual([]);
		expect(body.totals.events).toBe(0);
	});
});
