import { describe, expect, test, vi, type Mock } from 'vitest';
import {
	type CloudWatchLogsClient,
	type DescribeLogGroupsCommand,
	type LogGroup,
} from '@aws-sdk/client-cloudwatch-logs';
import { listLogGroups } from './log-groups';

type FakeSend = (command: unknown, options?: unknown) => Promise<unknown>;
type Fake = { client: CloudWatchLogsClient; send: Mock<FakeSend> };

/** Builds a fake client that returns each queued page in order. */
function fakeClient(pages: Array<{ logGroups?: LogGroup[]; nextToken?: string }>): Fake {
	let index = 0;
	const send = vi.fn<FakeSend>(async (_command: unknown) => {
		const page = pages[index] ?? { logGroups: [] };
		index += 1;
		return page;
	});
	return { client: { send } as unknown as CloudWatchLogsClient, send };
}

describe('listLogGroups', () => {
	test('maps groups, sorts by name and de-duplicates', async () => {
		const { client } = fakeClient([
			{
				logGroups: [
					{ logGroupName: '/b', arn: 'arn:b', storedBytes: 20 },
					{ logGroupName: '/a', arn: 'arn:a', retentionInDays: 7 },
					{ logGroupName: '/b', arn: 'arn:b' },
				],
			},
		]);
		const groups = await listLogGroups(client);
		expect(groups).toEqual([
			{ name: '/a', arn: 'arn:a', retentionInDays: 7 },
			{ name: '/b', arn: 'arn:b', storedBytes: 20 },
		]);
	});

	test('requests pages of 50 and follows nextToken', async () => {
		const { client, send } = fakeClient([
			{ logGroups: [{ logGroupName: '/one' }], nextToken: 'page-2' },
			{ logGroups: [{ logGroupName: '/two' }] },
		]);
		const groups = await listLogGroups(client);
		expect(groups.map((group) => group.name)).toEqual(['/one', '/two']);
		expect(send).toHaveBeenCalledTimes(2);
		const first = (send.mock.calls[0][0] as DescribeLogGroupsCommand).input;
		const second = (send.mock.calls[1][0] as DescribeLogGroupsCommand).input;
		expect(first).toEqual({ limit: 50 });
		expect(second).toEqual({ limit: 50, nextToken: 'page-2' });
	});

	test('passes the prefix and filters the result on the client too', async () => {
		const { client, send } = fakeClient([
			{
				logGroups: [
					{ logGroupName: '/aws/lambda/checkout' },
					{ logGroupName: '/aws/ecs/task' },
					{ logGroupName: '/other' },
				],
			},
		]);
		const groups = await listLogGroups(client, { prefix: '/aws/lambda' });
		expect(groups.map((group) => group.name)).toEqual(['/aws/lambda/checkout']);
		expect((send.mock.calls[0][0] as DescribeLogGroupsCommand).input.logGroupNamePrefix).toBe(
			'/aws/lambda',
		);
	});

	test('stops at the limit and clamps it into 1..1000', async () => {
		const page = {
			logGroups: [{ logGroupName: '/a' }, { logGroupName: '/b' }, { logGroupName: '/c' }],
		};
		const limited = await listLogGroups(fakeClient([page]).client, { limit: 2 });
		expect(limited.map((group) => group.name)).toEqual(['/a', '/b']);
		const clampedLow = await listLogGroups(fakeClient([page]).client, { limit: 0 });
		expect(clampedLow.map((group) => group.name)).toEqual(['/a']);
		const clampedHigh = await listLogGroups(fakeClient([page]).client, { limit: 5000 });
		expect(clampedHigh).toHaveLength(3);
	});

	test('hops pages until the limit is reached', async () => {
		const { client, send } = fakeClient([
			{ logGroups: [{ logGroupName: '/a' }], nextToken: 'page-2' },
			{ logGroups: [{ logGroupName: '/b' }] },
		]);
		const groups = await listLogGroups(client, { limit: 1 });
		expect(groups.map((group) => group.name)).toEqual(['/a']);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test('forwards the abort signal to the SDK', async () => {
		const controller = new AbortController();
		const { client, send } = fakeClient([{ logGroups: [{ logGroupName: '/a' }] }]);
		await listLogGroups(client, { signal: controller.signal });
		expect(send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
	});

	test('does not call the API when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const { client, send } = fakeClient([{ logGroups: [{ logGroupName: '/a' }] }]);
		await expect(listLogGroups(client, { signal: controller.signal })).resolves.toEqual([]);
		expect(send).not.toHaveBeenCalled();
	});

	test('propagates SDK failures to the caller', async () => {
		const failure = new Error('boom');
		const send = vi.fn<() => Promise<never>>(async () => {
			throw failure;
		});
		const client = { send } as unknown as CloudWatchLogsClient;
		await expect(listLogGroups(client)).rejects.toBe(failure);
	});
});
