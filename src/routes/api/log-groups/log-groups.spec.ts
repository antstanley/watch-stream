import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
	CloudWatchLogsClient,
	DescribeLogGroupsCommand,
	LogGroup,
} from '@aws-sdk/client-cloudwatch-logs';
import type { RequestEvent } from '@sveltejs/kit';
import type * as AwsServer from '$lib/server/aws';
import { REGION_PARAM_HINT } from '$lib/server/aws';
import { GET } from './+server';

type FakeSend = (command: unknown, options?: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	send: vi.fn<FakeSend>(),
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
				send: mocks.send,
				config: { region: mocks.region },
				destroy: mocks.destroy,
			} as unknown as CloudWatchLogsClient;
		},
	};
});

type PollResult = { logGroups?: LogGroup[]; nextToken?: string } | Error;

/** Queues the responses the fake client returns in order. */
function queueSend(results: PollResult[]): void {
	let index = 0;
	mocks.send.mockImplementation(async (_command: unknown) => {
		const result = results[index] ?? { logGroups: [] };
		index += 1;
		if (result instanceof Error) throw result;
		return result;
	});
}

/** Builds a minimal RequestEvent for a route handler. */
function requestEvent(query: string, signal?: AbortSignal): RequestEvent {
	const url = new URL(`http://localhost/api/log-groups${query}`);
	const request = new Request(url, signal === undefined ? undefined : { signal });
	return { url, request } as unknown as RequestEvent;
}

describe('GET /api/log-groups', () => {
	beforeEach(() => {
		envState.current = { AWS_REGION: 'eu-west-1' };
		mocks.send.mockReset();
		mocks.region.mockReset();
		mocks.region.mockResolvedValue('us-west-1');
		mocks.destroy.mockReset();
		mocks.failCreate.current = false;
		queueSend([{ logGroups: [] }]);
	});

	test('returns the groups with the resolved region and endpoint', async () => {
		queueSend([
			{
				logGroups: [
					{ logGroupName: '/aws/lambda/checkout', arn: 'arn:checkout', storedBytes: 1024 },
					{ logGroupName: '/aws/ecs/task' },
				],
			},
		]);
		const response = await GET(requestEvent('?region=us-west-2&prefix=/aws/lambda'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			region: 'us-west-2',
			endpoint: null,
			groups: [{ name: '/aws/lambda/checkout', arn: 'arn:checkout', storedBytes: 1024 }],
		});
		const command = mocks.send.mock.calls[0][0] as DescribeLogGroupsCommand;
		expect(command.input).toEqual({ limit: 50, logGroupNamePrefix: '/aws/lambda' });
	});

	test('reports the local endpoint', async () => {
		envState.current = {
			AWS_DEFAULT_REGION: 'us-east-1',
			AWS_ENDPOINT_URL: 'http://localhost:4566',
		};
		const body = (await (await GET(requestEvent(''))).json()) as {
			region: string;
			endpoint: string | null;
		};
		expect(body.region).toBe('us-east-1');
		expect(body.endpoint).toBe('http://localhost:4566');
	});

	test('caps the result count and forwards the request signal', async () => {
		const controller = new AbortController();
		const logGroups = Array.from({ length: 12 }, (_value, index) => ({
			logGroupName: `/group-${String(index + 1).padStart(2, '0')}`,
		}));
		queueSend([{ logGroups }]);
		const event = requestEvent('?limit=10', controller.signal);
		const body = (await (await GET(event)).json()) as { groups: Array<{ name: string }> };
		expect(body.groups).toHaveLength(10);
		expect(body.groups[0].name).toBe('/group-01');
		const command = mocks.send.mock.calls[0][0] as DescribeLogGroupsCommand;
		expect(command.input.limit).toBe(50);
		// `new Request(url, { signal })` wraps the signal, so compare identity with the event's.
		expect(mocks.send.mock.calls[0][1]).toEqual({ abortSignal: event.request.signal });
		expect(mocks.destroy).toHaveBeenCalled();
	});

	test.each([['?limit=abc'], ['?limit=0'], ['?limit=-1'], ['?limit=1001'], ['?limit=2.5']])(
		'returns 400 for %s',
		async (query) => {
			const response = await GET(requestEvent(query));
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; code?: string };
			expect(body.code).toBe('invalid-limit');
			expect(body.error).toContain('limit');
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	test('uses WATCH_STREAM_LIMIT as the default result count', async () => {
		envState.current = { AWS_REGION: 'eu-west-1', WATCH_STREAM_LIMIT: '2' };
		queueSend([
			{
				logGroups: [{ logGroupName: '/a' }, { logGroupName: '/b' }, { logGroupName: '/c' }],
			},
		]);
		const body = (await (await GET(requestEvent(''))).json()) as {
			groups: Array<{ name: string }>;
		};
		expect(body.groups.map((group) => group.name)).toEqual(['/a', '/b']);
	});

	test('ignores a misconfigured WATCH_STREAM_LIMIT', async () => {
		envState.current = { AWS_REGION: 'eu-west-1', WATCH_STREAM_LIMIT: 'lots' };
		const response = await GET(requestEvent(''));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ region: 'eu-west-1', endpoint: null, groups: [] });
	});

	test('lets the query parameter win over WATCH_STREAM_LIMIT', async () => {
		envState.current = { AWS_REGION: 'eu-west-1', WATCH_STREAM_LIMIT: '2' };
		queueSend([
			{
				logGroups: [{ logGroupName: '/a' }, { logGroupName: '/b' }, { logGroupName: '/c' }],
			},
		]);
		const body = (await (await GET(requestEvent('?limit=3'))).json()) as {
			groups: Array<{ name: string }>;
		};
		expect(body.groups).toHaveLength(3);
	});

	test('uses the ambient region when the query parameter is absent', async () => {
		envState.current = {};
		const body = (await (await GET(requestEvent(''))).json()) as { region: string };
		expect(body.region).toBe('us-west-1');
		expect(mocks.region).toHaveBeenCalledTimes(1);
	});

	test('treats a blank region parameter as absent', async () => {
		envState.current = {};
		const body = (await (await GET(requestEvent('?region=%20'))).json()) as { region: string };
		expect(body.region).toBe('us-west-1');
		expect(mocks.region).toHaveBeenCalledTimes(1);
	});

	test('keeps AWS_REGION when the region parameter is blank', async () => {
		const body = (await (await GET(requestEvent('?region='))).json()) as { region: string };
		expect(body.region).toBe('eu-west-1');
		expect(mocks.region).not.toHaveBeenCalled();
	});

	test('keeps the endpoint region from the query parameter without asking ambient config', async () => {
		const body = (await (await GET(requestEvent('?region=us-west-2'))).json()) as {
			region: string;
		};
		expect(body.region).toBe('us-west-2');
		expect(mocks.region).not.toHaveBeenCalled();
	});

	test.each([['?region=US-EAST-1'], ['?region=us_east_1'], ['?region=us%20east%201']])(
		'returns 400 invalid-region for %s',
		async (query) => {
			const response = await GET(requestEvent(query));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: REGION_PARAM_HINT, code: 'invalid-region' });
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	test('returns 502 with missing-region when no client can be created', async () => {
		mocks.failCreate.current = true;
		const response = await GET(requestEvent(''));
		expect(response.status).toBe(502);
		const body = (await response.json()) as { code?: string; error: string };
		expect(body.code).toBe('missing-region');
		expect(body.error).toContain('No AWS region is configured');
	});

	test('returns 502 with an ApiErrorBody when CloudWatch Logs fails', async () => {
		queueSend([
			Object.assign(new Error('User is not authorized to perform logs:DescribeLogGroups'), {
				name: 'AccessDeniedException',
			}),
		]);
		const response = await GET(requestEvent(''));
		expect(response.status).toBe(502);
		const body = (await response.json()) as { error: string; code?: string; details?: string };
		expect(body.code).toBe('access-denied');
		expect(body.error).toContain('Access denied');
		expect(body.details).toBeUndefined();
		expect(mocks.destroy).toHaveBeenCalled();
	});

	test('returns 499 when the client aborts mid-request', async () => {
		const controller = new AbortController();
		mocks.send.mockImplementation(async () => {
			controller.abort();
			throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
		});
		const response = await GET(requestEvent('', controller.signal));
		expect(response.status).toBe(499);
		expect(await response.json()).toEqual({
			error: 'The client closed the request before CloudWatch Logs replied',
			code: 'aborted',
		});
	});

	test('never leaks a stack trace in an error body', async () => {
		queueSend([new Error('unexpected')]);
		const response = await GET(requestEvent(''));
		const text = await response.text();
		expect(response.status).toBe(502);
		expect(text).not.toContain('at ');
		expect(text).not.toContain('\n');
	});
});
