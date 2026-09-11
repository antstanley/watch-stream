import { describe, expect, it, vi } from 'vitest';
import {
	ApiError,
	DEFAULT_REGIONS,
	apiErrorMessage,
	buildLogGroupsUrl,
	describeGroupsError,
	describeStreamError,
	fetchHealth,
	fetchLogGroups,
	fetchRegions,
	isApiErrorBody,
	noGroupsMessage,
	sortGroups,
} from './groups-client';
import type { FetchLike } from './groups-client';
import type { HealthResponse } from './types';

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
});
