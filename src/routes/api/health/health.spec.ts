import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { RequestEvent } from '@sveltejs/kit';
import type * as AwsServer from '$lib/server/aws';
import { FALLBACK_REGION, REGION_PARAM_HINT } from '$lib/server/aws';
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

/** Builds a minimal RequestEvent for a route handler. */
function requestEvent(url: string, signal?: AbortSignal): RequestEvent {
	const parsed = new URL(url);
	const request = new Request(parsed, signal === undefined ? undefined : { signal });
	return { url: parsed, request } as unknown as RequestEvent;
}

describe('GET /api/health', () => {
	beforeEach(() => {
		envState.current = {};
		mocks.region.mockReset();
		mocks.region.mockResolvedValue('us-west-1');
		mocks.destroy.mockReset();
		mocks.failCreate.current = false;
	});

	test('defers to the ambient AWS region when nothing is supplied', async () => {
		const response = await GET(requestEvent('http://localhost/api/health'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			region: 'us-west-1',
			endpoint: null,
			local: false,
			credentials: 'ambient',
		});
		expect(mocks.destroy).toHaveBeenCalled();
	});

	test('prefers AWS_REGION over the ambient provider', async () => {
		envState.current = { AWS_REGION: 'eu-west-1' };
		const body = (await (await GET(requestEvent('http://localhost/api/health'))).json()) as {
			region: string;
		};
		expect(body.region).toBe('eu-west-1');
		expect(mocks.region).not.toHaveBeenCalled();
	});

	test('accepts an explicit region query parameter', async () => {
		envState.current = { AWS_REGION: 'eu-west-1' };
		const body = (await (
			await GET(requestEvent('http://localhost/api/health?region=ap-south-1'))
		).json()) as { region: string };
		expect(body.region).toBe('ap-south-1');
		expect(mocks.region).not.toHaveBeenCalled();
	});

	test('treats a blank region parameter as absent', async () => {
		const response = await GET(requestEvent('http://localhost/api/health?region=%20'));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { region: string };
		expect(body.region).toBe('us-west-1');
		expect(mocks.region).toHaveBeenCalledTimes(1);
	});

	test('returns 400 for a malformed region', async () => {
		const response = await GET(requestEvent('http://localhost/api/health?region=US-EAST-1'));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: REGION_PARAM_HINT, code: 'invalid-region' });
		expect(mocks.destroy).not.toHaveBeenCalled();
	});

	test('reports the display fallback when the ambient provider fails', async () => {
		mocks.region.mockRejectedValue(new Error('Region is missing'));
		const response = await GET(requestEvent('http://localhost/api/health'));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; region: string };
		expect(body.ok).toBe(true);
		expect(body.region).toBe(FALLBACK_REGION);
	});

	test('returns 502 with missing-region when no client can be created', async () => {
		mocks.failCreate.current = true;
		const response = await GET(requestEvent('http://localhost/api/health'));
		expect(response.status).toBe(502);
		const body = (await response.json()) as { code?: string; error: string };
		expect(body.code).toBe('missing-region');
		expect(body.error).toContain('No AWS region is configured');
	});

	test('reports a local floci endpoint with the emulator credentials', async () => {
		envState.current = { AWS_ENDPOINT_URL: 'http://localhost:4566' };
		const body = (await (await GET(requestEvent('http://localhost/api/health'))).json()) as {
			endpoint: string | null;
			local: boolean;
			credentials: string;
		};
		expect(body.endpoint).toBe('http://localhost:4566');
		expect(body.local).toBe(true);
		expect(body.credentials).toBe('emulator-default');
	});

	test('reports ambient credentials when a local endpoint has them configured', async () => {
		envState.current = {
			AWS_ENDPOINT_URL: 'http://localhost:4566',
			AWS_ACCESS_KEY_ID: 'AKIALOCAL',
		};
		const body = (await (await GET(requestEvent('http://localhost/api/health'))).json()) as {
			credentials: string;
		};
		expect(body.credentials).toBe('ambient');
	});

	test('reports ambient credentials for a remote endpoint', async () => {
		envState.current = { AWS_ENDPOINT_URL: 'https://logs.eu-west-1.amazonaws.com' };
		const body = (await (await GET(requestEvent('http://localhost/api/health'))).json()) as {
			credentials: string;
			local: boolean;
		};
		expect(body.local).toBe(false);
		expect(body.credentials).toBe('ambient');
	});

	test('prefers AWS_ENDPOINT_URL_LOGS', async () => {
		envState.current = {
			AWS_ENDPOINT_URL_LOGS: 'http://logs.internal:7777',
			AWS_ENDPOINT_URL: 'http://localhost:4566',
		};
		const body = (await (await GET(requestEvent('http://localhost/api/health'))).json()) as {
			endpoint: string;
			local: boolean;
		};
		expect(body.endpoint).toBe('http://logs.internal:7777');
		expect(body.local).toBe(false);
	});
});
