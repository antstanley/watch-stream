import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { RequestEvent } from '@sveltejs/kit';
import type * as AwsServer from '$lib/server/aws';
import { REGION_PARAM_HINT } from '$lib/server/aws';
import { FALLBACK_REGIONS } from '$lib/server/regions';
import { GET } from './+server';

const mocks = vi.hoisted(() => ({
	region: vi.fn<() => Promise<string>>(),
	destroy: vi.fn<() => void>(),
	failCreate: { current: false },
}));
const envState = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));

vi.mock('$lib/server/env', () => ({ readEnv: () => envState.current }));
vi.mock('$lib/server/aws', async (importOriginal) => {
	const actual = await importOriginal<typeof AwsServer>();
	return {
		...actual,
		createLogsClient: () => {
			if (mocks.failCreate.current) throw new Error('Region is missing');
			return {
				config: { region: mocks.region },
				destroy: mocks.destroy,
			} as unknown as CloudWatchLogsClient;
		},
	};
});

type Body = { regions: string[]; defaultRegion: string; endpoint: string | null };

/** Builds a minimal RequestEvent for a route handler. */
function requestEvent(url: string): RequestEvent {
	const parsed = new URL(url);
	return { url: parsed, request: new Request(parsed) } as unknown as RequestEvent;
}

describe('GET /api/regions', () => {
	beforeEach(() => {
		envState.current = {};
		mocks.region.mockReset();
		mocks.region.mockResolvedValue('us-west-1');
		mocks.destroy.mockReset();
		mocks.failCreate.current = false;
	});

	test('defaults to the ambient region with the fallback list', async () => {
		const response = await GET(requestEvent('http://localhost/api/regions'));
		expect(response.status).toBe(200);
		const body = (await response.json()) as Body;
		expect(body.defaultRegion).toBe('us-west-1');
		expect(body.regions).toEqual(FALLBACK_REGIONS);
		expect(body.endpoint).toBeNull();
		expect(mocks.destroy).toHaveBeenCalled();
	});

	test('prepends an ambient region that is not in the list', async () => {
		// Outside the standard partition, so it can never be in the offered list.
		mocks.region.mockResolvedValue('us-gov-west-1');
		const body = (await (
			await GET(requestEvent('http://localhost/api/regions?region=us-gov-west-1'))
		).json()) as Body;
		expect(body.defaultRegion).toBe('us-gov-west-1');
		expect(body.regions[0]).toBe('us-gov-west-1');
	});

	test('honours WATCH_STREAM_REGIONS and the configured default region', async () => {
		envState.current = {
			AWS_DEFAULT_REGION: 'us-east-2',
			AWS_ENDPOINT_URL: 'http://localhost:4566',
			WATCH_STREAM_REGIONS: ' eu-west-1 , us-east-2 ',
		};
		const body = (await (await GET(requestEvent('http://localhost/api/regions'))).json()) as Body;
		expect(body.defaultRegion).toBe('us-east-2');
		expect(body.regions).toEqual(['eu-west-1', 'us-east-2']);
		expect(body.endpoint).toBe('http://localhost:4566');
	});

	test('prepends a default region that is missing from the configured list', async () => {
		envState.current = { WATCH_STREAM_REGIONS: 'us-west-2' };
		mocks.region.mockResolvedValue('ap-south-1');
		const body = (await (await GET(requestEvent('http://localhost/api/regions'))).json()) as Body;
		expect(body.defaultRegion).toBe('ap-south-1');
		expect(body.regions).toEqual(['ap-south-1', 'us-west-2']);
	});

	test('lets an explicit region parameter win over the ambient region', async () => {
		const body = (await (
			await GET(requestEvent('http://localhost/api/regions?region=us-west-2'))
		).json()) as Body;
		expect(body.defaultRegion).toBe('us-west-2');
		expect(mocks.region).not.toHaveBeenCalled();
	});

	test('treats a blank region parameter as absent', async () => {
		const body = (await (
			await GET(requestEvent('http://localhost/api/regions?region='))
		).json()) as Body;
		expect(body.defaultRegion).toBe('us-west-1');
		expect(mocks.region).toHaveBeenCalledTimes(1);
	});

	test('returns 400 for a malformed region', async () => {
		const response = await GET(requestEvent('http://localhost/api/regions?region=us_east_1'));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: REGION_PARAM_HINT, code: 'invalid-region' });
	});

	test('returns 502 with missing-region when no client can be created', async () => {
		mocks.failCreate.current = true;
		const response = await GET(requestEvent('http://localhost/api/regions'));
		expect(response.status).toBe(502);
		const body = (await response.json()) as { code?: string };
		expect(body.code).toBe('missing-region');
	});
});
