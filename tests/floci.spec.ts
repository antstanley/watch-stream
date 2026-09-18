/**
 * End-to-end checks against a running floci (or LocalStack) emulator.
 *
 * Enable with:
 *   WATCH_TAIL_E2E=1 pnpm test:e2e
 *
 * The emulator must be reachable at AWS_ENDPOINT_URL (default http://localhost:4566).
 * These tests write only to a uniquely named, throwaway log group.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { getArchive, resetArchive } from '../src/lib/server/archive.ts';
import { listLogGroups } from '../src/lib/server/log-groups.ts';
import { tailLogEvents } from '../src/lib/server/tail.ts';
import { GET as logGroupsGET } from '../src/routes/api/log-groups/+server.ts';
import { GET as streamGET } from '../src/routes/api/stream/+server.ts';

// `pnpm floci:up` writes `.env.local`; vitest does not load it by itself.
const localEnvFile = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env.local');
if (existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);

const enabled = process.env.WATCH_TAIL_E2E === '1';
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const region = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const groupName = `/watch-tail/e2e-${Date.now()}`;
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

		const groups = await listLogGroups(client, { prefix: '/watch-tail/' });
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

	it('archives streamed events and replays them from the local file', async () => {
		// Explicit opt-in: the archive is off inside a test process by default.
		const dir = mkdtempSync(join(tmpdir(), 'watch-tail-e2e-archive-'));
		const dbPath = join(dir, 'archive.duckdb');
		process.env.WATCH_TAIL_ARCHIVE_DB = dbPath;
		resetArchive();
		try {
			const archive = await getArchive(process.env);
			expect(archive.available).toBe(true);

			// One declared level and one level word in plain text, so both detection
			// paths are exercised against a real emulator.
			await put(['{"level":"error","msg":"checkout failed"}', 'WARN slow upstream']);

			// 1. Stream live through the route exactly as the UI does: the route is
			//    what writes the archive.
			const controller = new AbortController();
			const url = new URL('http://localhost/api/stream');
			url.searchParams.set('region', region);
			url.searchParams.set('group', groupName);
			url.searchParams.set('startTime', String(Date.now() - 60_000));
			url.searchParams.set('poll', '250');
			const response = await streamGET({
				request: new Request(url, { signal: controller.signal }),
				url,
			} as never);
			const frames = await readSse(response, (collected) =>
				collected.some((frame) => frame.includes('"live-2"')),
			);
			controller.abort();
			expect(frames.some((frame) => frame.startsWith('event: log'))).toBe(true);

			// 2. The rows are on disk, de-duplicated.
			const totals = await archive.totals();
			expect(totals.rows).toBeGreaterThanOrEqual(3);
			expect(totals.groups).toBe(1);

			// 3. Listing groups from the archive needs no AWS call at all.
			const groupsUrl = new URL('http://localhost/api/log-groups');
			groupsUrl.searchParams.set('region', region);
			groupsUrl.searchParams.set('source', 'archive');
			const groupsResponse = await logGroupsGET({ url: groupsUrl } as never);
			const groupsBody = (await groupsResponse.json()) as {
				source: string;
				endpoint: string | null;
				groups: { name: string; archivedEvents?: number }[];
			};
			expect(groupsBody.source).toBe('archive');
			expect(groupsBody.endpoint).toBeNull();
			expect(groupsBody.groups.map((entry) => entry.name)).toContain(groupName);
			expect(groupsBody.groups[0]?.archivedEvents).toBeGreaterThanOrEqual(3);

			// 4. Replay the same window from the file and compare with what CloudWatch
			//    returned a moment ago.
			const replayUrl = new URL('http://localhost/api/stream');
			replayUrl.searchParams.set('region', region);
			replayUrl.searchParams.set('group', groupName);
			replayUrl.searchParams.set('source', 'archive');
			replayUrl.searchParams.set('from', String(Date.now() - 60_000));
			replayUrl.searchParams.set('to', String(Date.now() + 60_000));
			const replay = await streamGET({
				request: new Request(replayUrl),
				url: replayUrl,
			} as never);
			expect(replay.status).toBe(200);
			const replayFrames = await readSse(replay, (collected) =>
				collected.some((frame) => frame.includes('event: end')),
			);
			expect(replayFrames[0]).toContain('"source":"archive"');
			expect(replayFrames[0]).toContain('"mode":"historic"');
			const replayLogs = replayFrames.filter((frame) => frame.startsWith('event: log')).join('\n');
			expect(replayLogs).toContain('boot ok');
			expect(replayLogs).toContain('live-1');
			expect(replayLogs).toContain('live-2');
			expect(replayFrames.some((frame) => frame.includes('"window-complete"'))).toBe(true);

			// 4b. Levels came back with the rows, and the level filter uses them.
			const levelsUrl = new URL(replayUrl);
			levelsUrl.searchParams.set('search', 'checkout failed');
			const withLevels = await streamGET({
				request: new Request(levelsUrl),
				url: levelsUrl,
			} as never);
			const levelFrames = await readSse(withLevels, (collected) =>
				collected.some((frame) => frame.includes('event: end')),
			);
			expect(levelFrames.filter((frame) => frame.startsWith('event: log')).join('\n')).toContain(
				'"level":"error"',
			);

			const errorOnlyUrl = new URL(replayUrl);
			errorOnlyUrl.searchParams.set('level', 'error');
			const errorOnly = await streamGET({
				request: new Request(errorOnlyUrl),
				url: errorOnlyUrl,
			} as never);
			const errorFrames = await readSse(errorOnly, (collected) =>
				collected.some((frame) => frame.includes('event: end')),
			);
			const errorLogs = errorFrames.filter((frame) => frame.startsWith('event: log')).join('\n');
			expect(errorLogs).toContain('checkout failed');
			expect(errorLogs).not.toContain('live-1');

			const warnOnlyUrl = new URL(replayUrl);
			warnOnlyUrl.searchParams.set('level', 'warn');
			const warnOnly = await streamGET({
				request: new Request(warnOnlyUrl),
				url: warnOnlyUrl,
			} as never);
			const warnFrames = await readSse(warnOnly, (collected) =>
				collected.some((frame) => frame.includes('event: end')),
			);
			const warnLogs = warnFrames.filter((frame) => frame.startsWith('event: log')).join('\n');
			expect(warnLogs).toContain('WARN slow upstream');
			expect(warnLogs).not.toContain('checkout failed');

			// 5. Nothing is written when reading the archive back.
			expect((await archive.totals()).rows).toBe(totals.rows);

			// 6. A search narrows the replay without touching CloudWatch.
			const searchUrl = new URL(replayUrl);
			searchUrl.searchParams.set('search', 'live-1');
			const searched = await streamGET({
				request: new Request(searchUrl),
				url: searchUrl,
			} as never);
			const searchFrames = await readSse(searched, (collected) =>
				collected.some((frame) => frame.includes('event: end')),
			);
			const searchLogs = searchFrames.filter((frame) => frame.startsWith('event: log')).join('\n');
			expect(searchLogs).toContain('live-1');
			expect(searchLogs).not.toContain('boot ok');

			await archive.close();
			expect(existsSync(dbPath)).toBe(true);
		} finally {
			delete process.env.WATCH_TAIL_ARCHIVE_DB;
			resetArchive();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	afterAll(async () => {
		if (!enabled) return;
		await client
			.send(new DeleteLogGroupCommand({ logGroupName: groupName }))
			.catch(() => undefined);
	});
});
