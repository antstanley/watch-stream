/**
 * End-to-end checks against a running floci (or LocalStack) emulator.
 *
 * Enable with:
 *   WATCH_STREAM_E2E=1 pnpm test:e2e
 *
 * The emulator must be reachable at AWS_ENDPOINT_URL (default http://localhost:4566).
 * These tests write only to a uniquely named, throwaway log group.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	CloudWatchLogsClient,
	CreateLogGroupCommand,
	CreateLogStreamCommand,
	DeleteLogGroupCommand,
	PutLogEventsCommand,
	type InputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { listLogGroups } from '../src/lib/server/log-groups.ts';
import { tailLogEvents } from '../src/lib/server/tail.ts';
import { GET as streamGET } from '../src/routes/api/stream/+server.ts';

// `pnpm floci:up` writes `.env.local`; vitest does not load it by itself.
const localEnvFile = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env.local');
if (existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);

const enabled = process.env.WATCH_STREAM_E2E === '1';
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const region = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const groupName = `/watch-stream/e2e-${Date.now()}`;
const streamName = 'e2e-stream';

const client = new CloudWatchLogsClient({
	region,
	endpoint,
	credentials: {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
	},
});

function event(message: string, timestamp: number): InputLogEvent {
	// `InputLogEvent.timestamp` is epoch milliseconds, not a Date.
	return { message, timestamp };
}

async function put(messages: string[]): Promise<void> {
	const now = Date.now();
	await client.send(
		new PutLogEventsCommand({
			logGroupName: groupName,
			logStreamName: streamName,
			logEvents: messages.map((message, index) => event(message, now + index)),
		}),
	);
}

/** Read SSE frames from a Response body until `stop` returns true or the timeout fires. */
async function readSse(
	response: Response,
	stop: (frames: string[]) => boolean,
	timeoutMs = 20_000,
): Promise<string[]> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error('response has no body');
	const decoder = new TextDecoder();
	const frames: string[] = [];
	let buffer = '';
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let index = buffer.indexOf('\n\n');
		while (index >= 0) {
			frames.push(buffer.slice(0, index));
			buffer = buffer.slice(index + 2);
			index = buffer.indexOf('\n\n');
		}
		if (stop(frames)) break;
	}
	await reader.cancel();
	return frames;
}

describe.runIf(enabled)('floci integration', () => {
	it('creates a log group, backfills events and lists it', async () => {
		await client.send(new CreateLogGroupCommand({ logGroupName: groupName }));
		await client.send(
			new CreateLogStreamCommand({ logGroupName: groupName, logStreamName: streamName }),
		);
		await put(['boot ok']);

		const groups = await listLogGroups(client, { prefix: '/watch-stream/' });
		expect(groups.map((group) => group.name)).toContain(groupName);
	}, 30_000);

	it('tails existing events and then live events, without duplicates', async () => {
		const controller = new AbortController();
		const seen: string[] = [];
		const consume = (async () => {
			for await (const batch of tailLogEvents({
				client,
				logGroupName: groupName,
				startTime: Date.now() - 60_000,
				pollIntervalMs: 250,
				signal: controller.signal,
			})) {
				if (batch.type !== 'events') continue;
				seen.push(...batch.events.map((entry) => entry.message));
				if (seen.includes('live-2')) {
					controller.abort();
					return;
				}
			}
		})();

		await new Promise((resolve) => setTimeout(resolve, 500));
		await put(['live-1']);
		await new Promise((resolve) => setTimeout(resolve, 700));
		await put(['live-2']);

		await Promise.race([
			consume,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('tail did not deliver live events in time')), 20_000),
			),
		]);

		expect(seen).toContain('boot ok');
		expect(seen).toContain('live-1');
		expect(seen).toContain('live-2');
		expect(new Set(seen).size).toBe(seen.length);
	}, 40_000);

	it('streams server-sent events from the /api/stream route', async () => {
		const controller = new AbortController();
		const url = new URL('http://localhost/api/stream');
		url.searchParams.set('region', region);
		url.searchParams.set('group', groupName);
		url.searchParams.set('lookback', '5m');
		url.searchParams.set('poll', '250');

		const response = await streamGET({
			request: new Request(url, { signal: controller.signal }),
			url,
		} as never);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');

		const frames = await readSse(response, (collected) =>
			collected.some((frame) => frame.includes('"live-2"')),
		);
		controller.abort();

		expect(frames[0]).toContain('event: ready');
		expect(frames[0]).toContain(groupName);
		const logFrames = frames.filter((frame) => frame.startsWith('event: log'));
		expect(logFrames.length).toBeGreaterThan(0);
		expect(logFrames.join('\n')).toContain('boot ok');
		expect(logFrames.join('\n')).toContain('"live-1"');
	}, 40_000);

	afterAll(async () => {
		if (!enabled) return;
		await client
			.send(new DeleteLogGroupCommand({ logGroupName: groupName }))
			.catch(() => undefined);
	});
});
