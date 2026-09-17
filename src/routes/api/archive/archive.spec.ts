import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as ArchiveServer from '$lib/server/archive';
import { GET } from './+server';
import { getArchive } from '$lib/server/archive';

type Status = {
	path: string;
	available: boolean;
	error: string | null;
	bytes: number | null;
	totals: {
		rows: number;
		groups: number;
		regions: number;
		oldest: number | null;
		newest: number | null;
	};
};

const okStatus: Status = {
	path: '/tmp/archive.duckdb',
	available: true,
	error: null,
	bytes: 4096,
	totals: { rows: 12, groups: 3, regions: 2, oldest: 1000, newest: 2000 },
};

const state = vi.hoisted(
	() =>
		({
			status: {
				path: '/tmp/archive.duckdb',
				available: true,
				error: null as string | null,
				bytes: 4096 as number | null,
				totals: {
					rows: 12,
					groups: 3,
					regions: 2,
					oldest: 1000 as number | null,
					newest: 2000 as number | null,
				},
			},
		}) as { status: Status },
);

vi.mock('$lib/server/archive', async (importOriginal) => {
	const actual = await importOriginal<typeof ArchiveServer>();
	return {
		...actual,
		getArchive: vi.fn<() => Promise<{ status: () => Promise<Status> }>>(async () => ({
			status: async () => state.status,
		})),
	};
});

describe('GET /api/archive', () => {
	test('routes status to the selected region and rejects malformed region paths', async () => {
		await GET({ url: new URL('http://localhost/api/archive?region=af-south-1') });
		expect(getArchive).toHaveBeenLastCalledWith(expect.anything(), {
			region: 'af-south-1',
			readOnly: true,
		});
		const bad = await GET({ url: new URL('http://localhost/api/archive?region=../escape') });
		expect(bad.status).toBe(400);
	});

	beforeEach(() => {
		state.status = okStatus;
	});

	test('reports the file, its size and the totals flat', async () => {
		const response = await GET({ url: new URL('http://localhost/api/archive') });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			path: '/tmp/archive.duckdb',
			available: true,
			error: null,
			bytes: 4096,
			rows: 12,
			groups: 3,
			regions: 2,
			oldest: 1000,
			newest: 2000,
		});
	});

	test('answers 200 with the reason when the archive is unavailable', async () => {
		state.status = {
			path: '/tmp/archive.duckdb',
			available: false,
			error: 'Cannot find module @duckdb/node-api',
			bytes: null,
			totals: { rows: 0, groups: 0, regions: 0, oldest: null, newest: null },
		};
		const response = await GET({ url: new URL('http://localhost/api/archive') });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			available: false,
			error: 'Cannot find module @duckdb/node-api',
			bytes: null,
			rows: 0,
		});
	});
});
