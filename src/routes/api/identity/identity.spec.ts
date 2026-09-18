import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { STSClient } from '@aws-sdk/client-sts';
import type { RequestEvent } from '@sveltejs/kit';
import type * as AwsServer from '$lib/server/aws';
import { REGION_PARAM_HINT } from '$lib/server/aws';
import { GET } from './+server';

const mocks = vi.hoisted(() => ({
	send: vi.fn<() => Promise<unknown>>(),
	destroy: vi.fn<() => void>(),
	region: vi.fn<() => Promise<string>>(),
}));
const envState = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));

vi.mock('$lib/server/env', () => ({ readEnv: () => envState.current }));
vi.mock('$lib/server/aws', async (importOriginal) => {
	const actual = await importOriginal<typeof AwsServer>();
	return {
		...actual,
		createStsClient: () =>
			({
				send: mocks.send,
				destroy: mocks.destroy,
				config: { region: mocks.region },
			}) as unknown as STSClient,
	};
});

type Body = {
	arn?: string;
	account?: string;
	userId?: string;
	region?: string;
	endpoint?: string | null;
	error?: string;
	code?: string;
};

/** Builds a minimal RequestEvent for the route handler. */
function requestEvent(url: string): RequestEvent {
	const parsed = new URL(url);
	return { url: parsed, request: new Request(parsed) } as unknown as RequestEvent;
}

describe('GET /api/identity', () => {
	beforeEach(() => {
		envState.current = {};
		mocks.send.mockReset();
		mocks.send.mockResolvedValue({
			Arn: 'arn:aws:sts::111111111111:assumed-role/Admin/me',
			Account: '111111111111',
			UserId: 'AROAEXAMPLE:me',
		});
		mocks.destroy.mockReset();
		mocks.region.mockReset();
		mocks.region.mockResolvedValue('us-west-1');
	});

	test('reports the resolved identity', async () => {
		const response = await GET(requestEvent('http://localhost/api/identity'));
		expect(response.status).toBe(200);
		const body = (await response.json()) as Body;
		expect(body).toEqual({
			arn: 'arn:aws:sts::111111111111:assumed-role/Admin/me',
			account: '111111111111',
			userId: 'AROAEXAMPLE:me',
			region: 'us-west-1',
			endpoint: null,
		});
		expect(mocks.destroy).toHaveBeenCalled();
	});

	test('accepts an explicit region and reports the endpoint', async () => {
		envState.current = { AWS_ENDPOINT_URL: 'http://localhost:4566' };
		const body = (await (
			await GET(requestEvent('http://localhost/api/identity?region=af-south-1'))
		).json()) as Body;
		expect(body.region).toBe('af-south-1');
		expect(body.endpoint).toBe('http://localhost:4566');
	});

	test('uses the STS endpoint independently of the Logs endpoint', async () => {
		envState.current = {
			AWS_ENDPOINT_URL_LOGS: 'https://logs.example.test',
			AWS_ENDPOINT_URL_STS: 'https://sts.example.test',
		};
		const response = await GET(requestEvent('http://localhost/api/identity'));
		expect(response.status).toBe(200);
		expect((await response.json()).endpoint).toBe('https://sts.example.test');
	});

	test('returns 400 for a malformed region', async () => {
		const response = await GET(requestEvent('http://localhost/api/identity?region=US-EAST-1'));
		expect(response.status).toBe(400);
		const body = (await response.json()) as Body;
		expect(body.code).toBe('invalid-region');
		expect(body.error).toBe(REGION_PARAM_HINT);
		expect(mocks.send).not.toHaveBeenCalled();
	});

	test('maps a credential failure from STS onto the shared error codes', async () => {
		mocks.send.mockRejectedValue(
			Object.assign(new Error('The SSO session token associated with profile=x was not found'), {
				name: 'CredentialsProviderError',
			}),
		);
		const response = await GET(requestEvent('http://localhost/api/identity'));
		expect(response.status).toBe(502);
		const body = (await response.json()) as Body;
		expect(body.code).toBe('missing-credentials');
		expect(body.error).not.toContain('    at ');
		expect(mocks.destroy).toHaveBeenCalled();
	});
});
