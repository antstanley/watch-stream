import { describe, expect, it, vi } from 'vitest';
import {
	ARCHIVE_NOTE,
	ApiError,
	DEFAULT_REGIONS,
	apiErrorMessage,
	buildLogGroupsUrl,
	describeArchive,
	describeGroupsError,
	describeStreamError,
	fetchArchiveStatus,
	fetchHealth,
	fetchLogGroups,
	fetchRegions,
	fetchSeries,
	isApiErrorBody,
	noArchivedGroupsMessage,
	noGroupsMessage,
	sortGroups,
} from './groups-client';
import type { FetchLike } from './groups-client';
import type { ArchiveStatusResponse, HealthResponse } from './types';

/** Builds a fake fetch that records the URLs it was asked for. */
function recordingFetch(body: unknown, urls: string[], status = 200): FetchLike {
	return (input) => {
		urls.push(input);
		return Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			}),
		);
	};
}

/** Builds a fake fetch that returns one JSON body. */
function stubFetch(body: unknown, status = 200): FetchLike {
	return vi.fn<FetchLike>(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			}),
	);
}

describe('DEFAULT_REGIONS', () => {
	it('contains the fallback default region', () => {
		expect(DEFAULT_REGIONS).toContain('us-east-1');
		expect(DEFAULT_REGIONS).toContain('af-south-1');
		expect(DEFAULT_REGIONS.length).toBeGreaterThan(1);
	});
});

describe('buildLogGroupsUrl', () => {
	it('sets only the parameters that are present', () => {
		expect(buildLogGroupsUrl({})).toBe('/api/log-groups');
		expect(buildLogGroupsUrl({ region: 'us-east-1' })).toBe('/api/log-groups?region=us-east-1');
		expect(buildLogGroupsUrl({ region: 'us-east-1', prefix: '/aws/lambda', limit: 50 })).toBe(
			'/api/log-groups?region=us-east-1&prefix=%2Faws%2Flambda&limit=50',
		);
	});

	it('carries the source parameter for the local archive', () => {
		expect(buildLogGroupsUrl({ region: 'us-east-1', source: 'archive' })).toBe(
			'/api/log-groups?region=us-east-1&source=archive',
		);
	});
});

describe('isApiErrorBody / apiErrorMessage', () => {
	it('recognises an API error body', () => {
		expect(isApiErrorBody({ error: 'boom' })).toBe(true);
		expect(isApiErrorBody({ nope: true })).toBe(false);
		expect(isApiErrorBody(null)).toBe(false);
	});

	it('reads the error message with a fallback', () => {
		expect(apiErrorMessage({ error: 'boom' })).toBe('boom');
		expect(apiErrorMessage({}, 'fallback')).toBe('fallback');
	});
});

describe('fetchRegions', () => {
	it('returns the parsed payload', async () => {
		const body = { regions: ['us-east-1'], defaultRegion: 'us-east-1', endpoint: null };
		const response = await fetchRegions({ fetchImpl: stubFetch(body) });
		expect(response.defaultRegion).toBe('us-east-1');
	});
});

describe('fetchHealth', () => {
	it('returns the parsed payload', async () => {
		const body = {
			ok: true,
			region: 'us-east-1',
			endpoint: 'http://localhost:4566',
			local: true,
			credentials: 'ambient',
		};
		const response = await fetchHealth({ fetchImpl: stubFetch(body) });
		expect(response.local).toBe(true);
		expect(response.endpoint).toBe('http://localhost:4566');
		expect(response.credentials).toBe('ambient');
	});

	it('passes through the emulator-default credentials mode', async () => {
		const body: HealthResponse = {
			ok: true,
			region: 'us-east-1',
			endpoint: 'http://localhost:4566',
			local: true,
			credentials: 'emulator-default',
		};
		const response = await fetchHealth({ fetchImpl: stubFetch(body) });
		expect(response.credentials).toBe('emulator-default');
	});
});

describe('fetchLogGroups', () => {
	it('requests the group URL and returns groups', async () => {
		const fetchImpl = stubFetch({
			region: 'us-east-1',
			endpoint: null,
			groups: [{ name: '/aws/app' }],
		});
		const response = await fetchLogGroups({ region: 'us-east-1', fetchImpl });
		expect(response.groups).toHaveLength(1);
		expect(fetchImpl).toHaveBeenCalledWith('/api/log-groups?region=us-east-1', expect.anything());
	});

	it('throws an ApiError carrying the API message and code', async () => {
		const fetchImpl = stubFetch({ error: 'Access denied', code: 'AccessDeniedException' }, 502);
		const failure = await fetchLogGroups({ region: 'eu-west-1', fetchImpl }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).message).toBe('Access denied');
		expect((failure as ApiError).status).toBe(502);
		expect((failure as ApiError).code).toBe('AccessDeniedException');
	});

	it('passes the archive source through as a query parameter', async () => {
		const body = {
			region: 'us-east-1',
			endpoint: null,
			source: 'archive',
			groups: [{ name: '/aws/app', archivedEvents: 4 }],
		};
		const fetchImpl = stubFetch(body);
		const response = await fetchLogGroups({ region: 'us-east-1', source: 'archive', fetchImpl });

		expect(fetchImpl).toHaveBeenCalledWith(
			'/api/log-groups?region=us-east-1&source=archive',
			expect.anything(),
		);
		expect(response.source).toBe('archive');
		expect(response.groups[0].archivedEvents).toBe(4);
	});

	it('wraps a network failure in an ApiError', async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			throw new TypeError('fetch failed');
		});
		const failure = await fetchLogGroups({ region: 'us-east-1', fetchImpl }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).message).toContain('Could not reach');
	});
});

describe('fetchArchiveStatus', () => {
	const available: ArchiveStatusResponse = {
		path: '/tmp/archive.duckdb',
		available: true,
		error: null,
		bytes: 4096,
		rows: 12,
		groups: 3,
		regions: 2,
		oldest: 1000,
		newest: 2000,
	};

	it('requests /api/archive and returns the totals', async () => {
		const fetchImpl = stubFetch(available);
		const response = await fetchArchiveStatus({ fetchImpl });

		expect(fetchImpl).toHaveBeenCalledWith('/api/archive', expect.anything());
		expect(response.available).toBe(true);
		expect(response.path).toBe('/tmp/archive.duckdb');
		expect(response.groups).toBe(3);
	});

	it('returns the unavailable answer of the route as data, not as an error', async () => {
		const fetchImpl = stubFetch({
			...available,
			available: false,
			error: 'Cannot find module @duckdb/node-api',
			bytes: null,
			rows: 0,
			groups: 0,
			regions: 0,
			oldest: null,
			newest: null,
		});
		const response = await fetchArchiveStatus({ fetchImpl });

		expect(response.available).toBe(false);
		expect(response.error).toContain('@duckdb/node-api');
	});

	it('throws an ApiError when the API itself is unreachable', async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			throw new TypeError('fetch failed');
		});
		const failure = await fetchArchiveStatus({ fetchImpl }).then(
			() => null,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).message).toContain('Could not reach /api/archive');
	});
});

describe('sortGroups', () => {
	it('sorts by name without mutating the input', () => {
		const groups = [{ name: 'b' }, { name: 'a' }];
		expect(sortGroups(groups).map((group) => group.name)).toEqual(['a', 'b']);
		expect(groups[0].name).toBe('b');
	});
});

describe('error messages', () => {
	it('explains how to create sample groups', () => {
		expect(noGroupsMessage('us-east-1')).toBe(
			'No log groups found in us-east-1. Start floci and run `pnpm seed` to create sample groups.',
		);
	});

	it('adds region context to an API failure', () => {
		expect(describeGroupsError('eu-west-1', new ApiError('Access denied'))).toBe(
			'Could not list log groups in eu-west-1: Access denied.',
		);
		expect(describeGroupsError('eu-west-1', new ApiError('Session expired.'))).toBe(
			'Could not list log groups in eu-west-1: Session expired.',
		);
		expect(describeGroupsError('eu-west-1', new Error('socket closed'))).toContain('socket closed');
	});

	it('adds group context to a stream failure', () => {
		expect(describeStreamError('us-east-1', '/aws/app', 'group not found')).toBe(
			'group not found (/aws/app in us-east-1)',
		);
		expect(describeStreamError('us-east-1', null, 'gone')).toBe('gone (us-east-1)');
	});

	it('explains an empty archive list without calling it an error', () => {
		expect(noArchivedGroupsMessage('us-east-1')).toBe(
			'Nothing archived for us-east-1 yet - stream a group from CloudWatch once and it will appear here.',
		);
		expect(noArchivedGroupsMessage('')).toContain('this region');
	});

	it('describes the archive and names the database file behind it', () => {
		expect(describeArchive('/tmp/watch-tail/archive.duckdb')).toBe(
			'Locally archived events instead of live CloudWatch data (/tmp/watch-tail/archive.duckdb)',
		);
		expect(describeArchive(null)).toBe('Locally archived events instead of live CloudWatch data');
		expect(describeArchive('   ')).toBe('Locally archived events instead of live CloudWatch data');
		expect(ARCHIVE_NOTE).toContain('no CloudWatch credentials');
	});
});

describe('fetchSeries', () => {
	it('asks the archive for counts and carries the grouping mode', async () => {
		const urls: string[] = [];
		const fetchImpl = recordingFetch(
			{
				groupBy: 'request',
				from: 1,
				to: 2,
				bucketMs: 60_000,
				levels: [],
				groups: [],
				points: [],
				totals: { events: 0, points: 0 },
			},
			urls,
		);
		const response = await fetchSeries({
			region: 'us-east-1',
			groups: ['/aws/app'],
			from: 1_000,
			to: 2_000,
			levels: ['error'],
			by: 'request',
			fetchImpl,
		});
		expect(response.groupBy).toBe('request');
		expect(urls[0]).toContain('source=archive');
		expect(urls[0]).toContain('by=request');
		expect(urls[0]).toContain('level=error');
		expect(urls[0]).toContain('groups=%2Faws%2Fapp');
	});

	it('leaves the grouping mode out when it is not asked for', async () => {
		const urls: string[] = [];
		const fetchImpl = recordingFetch({ groupBy: 'event' }, urls);
		await fetchSeries({ region: 'us-east-1', groups: ['/aws/app'], from: 1, to: 2, fetchImpl });
		expect(urls[0]).not.toContain('by=');
	});
});
