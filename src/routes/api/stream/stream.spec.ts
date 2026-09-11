import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CloudWatchLogsClient, FilteredLogEvent } from '@aws-sdk/client-cloudwatch-logs';
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

type Frame = { event: string; data: unknown };
type PollResult = { events: FilteredLogEvent[] } | Error;

/** Builds a CloudWatch event for a poll result. */
function event(id: string, timestamp: number, message = 'line'): FilteredLogEvent {
	return {
		eventId: id,
		timestamp,
		message,
		logStreamName: `stream-${id}`,
		ingestionTime: timestamp + 1,
	};
}

/** Queues the responses the fake client returns in order. */
function queueSend(results: PollResult[]): void {
	let index = 0;
	mocks.send.mockImplementation(async () => {
		const result = results[index] ?? { events: [] };
		index += 1;
		if (result instanceof Error) throw result;
		return result;
	});
}

/** Builds a minimal RequestEvent for the SSE handler. */
function requestEvent(params: Record<string, string>, signal?: AbortSignal): RequestEvent {
	const url = new URL('http://localhost/api/stream');
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const request = new Request(url, signal === undefined ? undefined : { signal });
	return { url, request } as unknown as RequestEvent;
}

/** Parses one SSE block into a frame. */
function parseBlock(block: string): Frame[] {
	const lines = block.split('\n');
	const eventLine = lines.find((line) => line.startsWith('event: '));
	const dataLine = lines.find((line) => line.startsWith('data: '));
	if (eventLine === undefined || dataLine === undefined) return [];
	return [{ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) }];
}

type Reader = { frames: Frame[]; done: Promise<void>; cancel: () => Promise<void> };

/** Reads the SSE body in the background and collects the parsed frames. */
function startReading(response: Response): Reader {
	const body = response.body;
	if (body === null) throw new Error('the response has no body');
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const frames: Frame[] = [];
	const done = (async () => {
		let buffer = '';
		for (;;) {
			const { value, done: finished } = await reader.read();
			if (finished) break;
			buffer += decoder.decode(value, { stream: true });
			const blocks = buffer.split('\n\n');
			buffer = blocks.pop() ?? '';
			for (const block of blocks) frames.push(...parseBlock(block));
		}
	})();
	return { frames, done, cancel: () => reader.cancel() };
}

/** Waits for a predicate on real timers; used instead of sleeping blindly. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('condition timed out');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Rejects when a promise does not settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		}),
	]);
}

/** Starts a stream, waits for its first frames and aborts the client. */
async function readReady(
	params: Record<string, string>,
): Promise<{ frames: Frame[]; send: typeof mocks.send }> {
	const controller = new AbortController();
	const response = await GET(requestEvent(params, controller.signal));
	expect(response.status).toBe(200);
	const reader = startReading(response);
	await withTimeout(
		waitFor(() => reader.frames.length > 0),
		2000,
		'ready frame',
	);
	controller.abort();
	await withTimeout(reader.done, 2000, 'stream end');
	return { frames: reader.frames, send: mocks.send };
}

describe('GET /api/stream', () => {
	beforeEach(() => {
		envState.current = { AWS_REGION: 'eu-west-1' };
		mocks.send.mockReset();
		mocks.region.mockReset();
		mocks.region.mockResolvedValue('us-west-1');
		mocks.destroy.mockReset();
		mocks.failCreate.current = false;
		queueSend([{ events: [] }]);
	});

	test.each([[''], ['?region=eu-west-1'], ['?group='], ['?group=%20%20']])(
		'returns 400 for %s',
		async (query) => {
			const url = new URL(`http://localhost/api/stream${query}`);
			const response = await GET({
				url,
				request: new Request(url),
			} as unknown as RequestEvent);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; code?: string };
			expect(body.code).toBe('missing-group');
			expect(body.error).toContain('group');
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	test('streams ready, log and end frames', async () => {
		queueSend([{ events: [event('e1', 1000, 'hello')] }]);
		const controller = new AbortController();
		const response = await GET(
			requestEvent({ group: '/aws/lambda/demo', region: 'us-west-2' }, controller.signal),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
		expect(response.headers.get('connection')).toBe('keep-alive');
		expect(response.headers.get('x-accel-buffering')).toBe('no');

		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'log')),
			2000,
			'log frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');

		expect(reader.frames.map((frame) => frame.event)).toEqual(['ready', 'log', 'end']);
		expect(reader.frames[0].data).toEqual({
			region: 'us-west-2',
			logGroupName: '/aws/lambda/demo',
			endpoint: null,
			startTime: expect.any(Number),
			endTime: null,
			mode: 'live',
			preset: null,
			clamped: false,
		});
		expect(reader.frames[1].data).toEqual({
			events: [
				{
					id: 'e1',
					timestamp: 1000,
					message: 'hello',
					streamName: 'stream-e1',
					ingestionTime: 1001,
				},
			],
		});
		expect(reader.frames[2].data).toEqual({ reason: 'client-disconnected' });

		const command = mocks.send.mock.calls[0][0] as {
			input: { logGroupName: string; limit: number };
		};
		expect(command.input.logGroupName).toBe('/aws/lambda/demo');
		expect(command.input.limit).toBe(1000);
		expect(mocks.destroy).toHaveBeenCalled();
	});

	test('uses the ambient region when none is supplied', async () => {
		envState.current = {};
		const { frames } = await readReady({ group: 'demo' });
		expect((frames[0].data as { region: string }).region).toBe('us-west-1');
	});

	test('accepts an explicit region parameter', async () => {
		const { frames } = await readReady({ group: 'demo', region: 'us-west-2' });
		expect((frames[0].data as { region: string }).region).toBe('us-west-2');
		expect(mocks.region).not.toHaveBeenCalled();
	});

	test('returns 400 for a malformed region', async () => {
		const url = new URL('http://localhost/api/stream?group=demo&region=US-EAST-1');
		const response = await GET({
			url,
			request: new Request(url),
		} as unknown as RequestEvent);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: REGION_PARAM_HINT, code: 'invalid-region' });
		expect(mocks.send).not.toHaveBeenCalled();
	});

	test('returns 502 with missing-region when no client can be created', async () => {
		mocks.failCreate.current = true;
		const response = await GET(requestEvent({ group: 'demo' }));
		expect(response.status).toBe(502);
		const body = (await response.json()) as { code?: string; error: string };
		expect(body.code).toBe('missing-region');
		expect(body.error).toContain('No AWS region is configured');
	});

	test('reports a missing region from the tailer as an error frame', async () => {
		mocks.send.mockImplementation(async () => {
			throw new Error('Region is missing');
		});
		const controller = new AbortController();
		const response = await GET(requestEvent({ group: 'demo', poll: '250' }, controller.signal));
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'error')),
			2000,
			'error frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		const error = reader.frames.find((frame) => frame.event === 'error');
		expect(error?.data).toEqual({
			message: 'No AWS region is configured. Set AWS_REGION or add a region to your AWS profile.',
			code: 'missing-region',
		});
	});

	test('reports the local endpoint in the ready frame', async () => {
		envState.current = {
			AWS_DEFAULT_REGION: 'us-east-1',
			AWS_ENDPOINT_URL: 'http://localhost:4566',
		};
		const { frames } = await readReady({ group: 'demo' });
		expect(frames[0]).toEqual({
			event: 'ready',
			data: {
				region: 'us-east-1',
				logGroupName: 'demo',
				endpoint: 'http://localhost:4566',
				startTime: expect.any(Number),
				endTime: null,
				mode: 'live',
				preset: null,
				clamped: false,
			},
		});
	});

	test('honours an explicit startTime', async () => {
		const startTime = Date.now() - 60_000;
		const { frames, send } = await readReady({ group: 'demo', startTime: String(startTime) });
		expect(frames[0].data).toEqual({
			region: 'eu-west-1',
			logGroupName: 'demo',
			endpoint: null,
			startTime,
			endTime: null,
			mode: 'live',
			preset: null,
			clamped: false,
		});
		const command = send.mock.calls[0][0] as { input: { startTime: number } };
		expect(command.input.startTime).toBe(startTime);
	});

	test('falls back to the lookback window and clamps a bad poll interval', async () => {
		const before = Date.now();
		const { frames, send } = await readReady({ group: 'demo', lookback: '2h', poll: 'nonsense' });
		const after = Date.now();
		const startTime = (frames[0].data as { startTime: number }).startTime;
		expect(startTime).toBeGreaterThanOrEqual(before - 2 * 60 * 60 * 1000 - 1000);
		expect(startTime).toBeLessThanOrEqual(after - 2 * 60 * 60 * 1000 + 1000);
		const command = send.mock.calls[0][0] as { input: { startTime: number } };
		expect(command.input.startTime).toBe(startTime);
	});

	test('forwards the filter pattern', async () => {
		const { send } = await readReady({ group: 'demo', filterPattern: '?ERROR ?WARN' });
		const command = send.mock.calls[0][0] as { input: { filterPattern?: string } };
		expect(command.input.filterPattern).toBe('?ERROR ?WARN');
	});

	test('sends an error frame when CloudWatch Logs fails', async () => {
		mocks.send.mockImplementation(async () => {
			throw new Error('connect ECONNREFUSED 127.0.0.1:4566');
		});
		const controller = new AbortController();
		const response = await GET(requestEvent({ group: 'demo', poll: '250' }, controller.signal));
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'error')),
			2000,
			'error frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		const error = reader.frames.find((frame) => frame.event === 'error');
		expect(error?.data).toEqual({ message: expect.any(String), code: 'unreachable' });
		expect(reader.frames.at(-1)).toEqual({ event: 'end', data: { reason: 'client-disconnected' } });
	});

	test('closes the stream when the client cancels the body', async () => {
		const response = await GET(requestEvent({ group: 'demo' }));
		const reader = startReading(response);
		await withTimeout(reader.cancel(), 2000, 'cancel');
		await withTimeout(reader.done, 2000, 'stream end');
		expect(mocks.destroy).toHaveBeenCalled();
		expect(reader.frames.every((frame) => frame.event === 'ready')).toBe(true);
	});

	test('pings after 15 s of silence', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const controller = new AbortController();
			const response = await GET(requestEvent({ group: 'demo', poll: '250' }, controller.signal));
			const reader = startReading(response);
			await vi.advanceTimersByTimeAsync(16_000);
			expect(reader.frames.map((frame) => frame.event)).toContain('ping');
			const ping = reader.frames.find((frame) => frame.event === 'ping');
			expect(ping?.data).toEqual({ at: expect.any(Number) });
			controller.abort();
			await vi.advanceTimersByTimeAsync(1000);
			await reader.done;
			expect(reader.frames.at(-1)).toEqual({
				event: 'end',
				data: { reason: 'client-disconnected' },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test('ends with repeated-errors after too many failures', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			mocks.send.mockImplementation(async () => {
				throw new Error('connect ECONNREFUSED 127.0.0.1:4566');
			});
			const response = await GET(requestEvent({ group: 'demo', poll: '250' }));
			const reader = startReading(response);
			// Bounded steps of fake time until the tailer gives up and the stream ends.
			for (let step = 0; step < 400 && reader.frames.at(-1)?.event !== 'end'; step += 1) {
				await vi.advanceTimersByTimeAsync(1000);
			}
			await reader.done;
			const errorFrames = reader.frames.filter((frame) => frame.event === 'error');
			expect(errorFrames).toHaveLength(8);
			expect(reader.frames.at(-1)).toEqual({
				event: 'end',
				data: { reason: 'repeated-errors' },
			});
			expect(mocks.send).toHaveBeenCalledTimes(8);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('historic windows', () => {
	/** Reads a historic stream until its `end` frame, then cancels the body. */
	async function readHistoricUntilEnd(params: Record<string, string>): Promise<Frame[]> {
		const controller = new AbortController();
		const response = await GET(requestEvent(params, controller.signal));
		expect(response.status).toBe(200);
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'end')),
			3000,
			'end frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		return reader.frames;
	}

	/** Reads the ready frame for a historic request. */
	async function readHistoric(params: Record<string, string>): Promise<{
		ready: StreamReady;
		frames: Frame[];
	}> {
		const controller = new AbortController();
		const response = await GET(requestEvent(params, controller.signal));
		if (response.status !== 200) {
			throw new Error(`expected 200, got ${response.status}: ${await response.text()}`);
		}
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.length > 0),
			2000,
			'ready frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		return { ready: reader.frames[0].data as StreamReady, frames: reader.frames };
	}

	type StreamReady = {
		mode: string;
		startTime: number;
		endTime: number | null;
		preset: string | null;
		clamped: boolean;
	};

	test('reports the preset window in the ready frame and asks CloudWatch for it', async () => {
		queueSend([{ events: [] }]);
		const { ready } = await readHistoric({
			group: '/aws/lambda/demo',
			mode: 'historic',
			range: '24h',
		});

		expect(ready.mode).toBe('historic');
		expect(ready.preset).toBe('24h');
		expect(ready.endTime).not.toBeNull();
		expect((ready.endTime ?? 0) - ready.startTime).toBe(24 * 60 * 60 * 1000);

		// Other streams can still be polling, so find the command for this window.
		const command = mocks.send.mock.calls
			.map((call) => call[0] as { input: { startTime?: number; endTime?: number } })
			.find((candidate) => candidate.input.endTime === ready.endTime);
		expect(command?.input.startTime).toBe(ready.startTime);
	});

	test('accepts a custom from/to window', async () => {
		queueSend([{ events: [] }]);
		const to = Date.now() - 60 * 60 * 1000;
		const from = to - 90 * 60 * 1000;
		const { ready } = await readHistoric({
			group: '/aws/lambda/demo',
			mode: 'historic',
			from: String(from),
			to: String(to),
		});

		expect(ready.mode).toBe('historic');
		expect(ready.preset).toBeNull();
		expect(ready.startTime).toBe(from);
		expect(ready.endTime).toBe(to);
		expect(ready.clamped).toBe(false);
	});

	test('flags a clamped window', async () => {
		queueSend([{ events: [] }]);
		const { ready } = await readHistoric({
			group: '/aws/lambda/demo',
			mode: 'historic',
			from: String(Date.now() - 40 * 24 * 60 * 60 * 1000),
			to: String(Date.now()),
		});

		expect(ready.clamped).toBe(true);
		expect(ready.endTime).not.toBeNull();
		expect(ready.startTime).toBeGreaterThanOrEqual((ready.endTime ?? 0) - 14 * 24 * 60 * 60 * 1000);
	});

	test('ends with the tailer reason once a window is exhausted', async () => {
		queueSend([{ events: [event('e1', 1000, 'historic line')] }]);
		const frames = await readHistoricUntilEnd({
			group: '/aws/lambda/demo',
			mode: 'historic',
			range: '15m',
		});

		expect(frames.map((frame) => frame.event)).toEqual(['ready', 'log', 'end']);
		expect(frames.at(-1)?.data).toEqual({ reason: 'window-complete' });
	});

	test.each([
		['window', { range: '15m' }, 'invalid-mode'],
		['historic', { range: '5days' }, 'invalid-range'],
		['historic', { from: 'nope', to: 'nope' }, 'invalid-time'],
		['historic', { from: '1h' }, 'invalid-window'],
		['historic', { from: '1000', to: '999' }, 'invalid-window'],
	])('returns 400 for mode=%s %o', async (mode, params, code) => {
		const url = new URL('http://localhost/api/stream');
		url.searchParams.set('group', 'demo');
		url.searchParams.set('mode', mode);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

		const response = await GET({ url, request: new Request(url) } as unknown as RequestEvent);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; code?: string };
		expect(body.code).toBe(code);
		expect(body.error.length).toBeGreaterThan(0);
		expect(body.error).not.toContain('    at '); // never a stack trace
	});

	test('keeps live mode infinite even with a lookback', async () => {
		queueSend([{ events: [] }]);
		const { ready } = await readHistoric({ group: '/aws/lambda/demo', lookback: '30m' });
		expect(ready.mode).toBe('live');
		expect(ready.endTime).toBeNull();
	});
});
