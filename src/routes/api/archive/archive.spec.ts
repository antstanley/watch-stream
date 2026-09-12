import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as ArchiveServer from '$lib/server/archive';
import { GET } from './+server';

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
		getArchive: async () => ({ status: async () => state.status }),
	};
});

describe('GET /api/archive', () => {
	beforeEach(() => {
		state.status = okStatus;
	});

	test('reports the file, its size and the totals flat', async () => {
		const response = await GET();
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
		const response = await GET();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			available: false,
			error: 'Cannot find module @duckdb/node-api',
			bytes: null,
			rows: 0,
		});
	});
});
