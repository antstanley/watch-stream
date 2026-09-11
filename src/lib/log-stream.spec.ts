import { describe, expect, it } from 'vitest';
import {
	EVENT_SOURCE_CLOSED,
	EVENT_SOURCE_CONNECTING,
	EVENT_SOURCE_OPEN,
	LogStream,
	buildStreamUrl,
} from './log-stream.svelte';
import type { EventSourceLike, LogStreamOptions } from './log-stream.svelte';
import type { LogEventDto } from './types';

/** Test double for `EventSource` that the tests drive by hand. */
class FakeEventSource implements EventSourceLike {
	static instances: FakeEventSource[] = [];

	static reset(): void {
		FakeEventSource.instances = [];
	}

	static last(): FakeEventSource {
		const source = FakeEventSource.instances.at(-1);
		if (source === undefined) throw new Error('no EventSource was created');
		return source;
	}

	readonly url: string;
	readyState = EVENT_SOURCE_CONNECTING;
	closed = false;
	#listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
		const listeners = this.#listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
		this.#listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.closed = true;
		this.readyState = EVENT_SOURCE_CLOSED;
	}

	/** Number of listeners still attached for a named event. */
	listenerCount(type: string): number {
		return this.#listeners.get(type)?.size ?? 0;
	}

	open(): void {
		this.readyState = EVENT_SOURCE_OPEN;
		this.#dispatch('open', new Event('open'));
	}

	fail(readyState: number): void {
		this.readyState = readyState;
		this.#dispatch('error', new Event('error'));
	}

	emit(type: string, data: unknown): void {
		this.#dispatch(
			type,
			new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data) }),
		);
	}

	/** Delivers an event to the registered listeners. */
	#dispatch(type: string, event: Event): void {
		// A connection failure dispatches a plain Event; stream events dispatch a MessageEvent.
		const message = event as MessageEvent<string>;
		for (const listener of Array.from(this.#listeners.get(type) ?? [])) listener(message);
	}
}

/** Builds a stream wired to the fake source. */
function makeStream(options: LogStreamOptions = {}): LogStream {
	FakeEventSource.reset();
	return new LogStream({ createEventSource: (url) => new FakeEventSource(url), ...options });
}

/** One log event with a sequential message. */
function logEvent(index: number): LogEventDto {
	return { id: `id-${index}`, timestamp: 1_700_000_000_000 + index, message: `message ${index}` };
}

describe('buildStreamUrl', () => {
	it('encodes the required parameters', () => {
		expect(buildStreamUrl({ region: 'us-east-1', group: '/aws/app' })).toBe(
			'/api/stream?region=us-east-1&group=%2Faws%2Fapp',
		);
	});

	it('adds optional parameters when present', () => {
		const url = buildStreamUrl({
			region: 'eu-west-1',
			group: 'g',
			filterPattern: 'ERROR',
			startTime: 1700000000000,
			lookback: '15m',
			poll: 2000,
		});
		expect(url).toContain('filterPattern=ERROR');
		expect(url).toContain('startTime=1700000000000');
		expect(url).toContain('lookback=15m');
		expect(url).toContain('poll=2000');
	});

	it('honours a base URL', () => {
		expect(buildStreamUrl({ region: 'r', group: 'g' }, 'http://localhost:5173')).toBe(
			'http://localhost:5173/api/stream?region=r&group=g',
		);
	});
});

describe('LogStream connection lifecycle', () => {
	it('opens a connection for the target and reports live after onopen', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: '/aws/app' });

		expect(stream.status).toBe('connecting');
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(FakeEventSource.last().url).toBe('/api/stream?region=us-east-1&group=%2Faws%2Fapp');
		expect(stream.target?.group).toBe('/aws/app');

		FakeEventSource.last().open();
		expect(stream.status).toBe('live');
	});

	it('reports an error when the source cannot be created', () => {
		const stream = new LogStream({
			createEventSource: () => {
				throw new Error('EventSource is not available');
			},
		});
		stream.start({ region: 'us-east-1', group: 'g' });
		expect(stream.status).toBe('error');
		expect(stream.lastError?.message).toContain('not available');
	});

	it('closes the previous source when the target changes', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'first' });
		const first = FakeEventSource.last();
		stream.start({ region: 'us-east-1', group: 'second' });

		expect(first.closed).toBe(true);
		expect(first.listenerCount('log')).toBe(0);
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(stream.lines).toHaveLength(0);
	});

	it('stop() closes the source and forgets the target', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		const source = FakeEventSource.last();
		stream.stop();

		expect(source.closed).toBe(true);
		expect(stream.target).toBeNull();
		expect(stream.status).toBe('idle');
	});
});

describe('LogStream events', () => {
	it('appends log events and counts them', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().open();
		FakeEventSource.last().emit('log', { events: [logEvent(1), logEvent(2)] });

		expect(stream.lines.map((line) => line.message)).toEqual(['message 1', 'message 2']);
		expect(stream.receivedCount).toBe(2);
		expect(stream.status).toBe('live');
	});

	it('keeps the newest lines when the buffer cap is reached', () => {
		const stream = makeStream({ capacity: 2 });
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().emit('log', { events: [logEvent(1), logEvent(2), logEvent(3)] });

		expect(stream.lines.map((line) => line.message)).toEqual(['message 2', 'message 3']);
		expect(stream.droppedCount).toBe(1);
	});

	it('ignores malformed payloads without crashing', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().emit('log', 'not json');
		FakeEventSource.last().emit('log', { events: 'nope' });

		expect(stream.lines).toHaveLength(0);
		expect(stream.status).toBe('connecting');
	});

	it('stores the ready payload', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().emit('ready', {
			region: 'us-east-1',
			logGroupName: 'g',
			endpoint: 'http://localhost:4566',
			startTime: 1,
		});

		expect(stream.ready?.logGroupName).toBe('g');
		expect(stream.ready?.endpoint).toBe('http://localhost:4566');
		expect(stream.status).toBe('live');
	});

	it('records ping timestamps', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().emit('ping', { at: 1234 });
		expect(stream.lastEventAt).toBe(1234);
	});

	it('reports a server error payload', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().emit('error', { message: 'No log groups found', code: 'NotFound' });

		expect(stream.status).toBe('error');
		expect(stream.lastError?.message).toBe('No log groups found');
		expect(stream.lastError?.code).toBe('NotFound');
	});

	it('ignores an error event without a payload, which is a dropped connection', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().open();
		FakeEventSource.last().fail(EVENT_SOURCE_CONNECTING);
		FakeEventSource.last().emit('error', '');

		expect(stream.status).toBe('reconnecting');
		expect(stream.lastError).toBeNull();
	});

	it('closes and stops on the end event', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		const source = FakeEventSource.last();
		FakeEventSource.last().emit('end', { reason: 'group deleted' });

		expect(stream.status).toBe('ended');
		expect(stream.endReason).toBe('group deleted');
		expect(source.closed).toBe(true);
	});
});

describe('LogStream reconnect behaviour', () => {
	it('waits for the browser while the source is still connecting', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().open();
		FakeEventSource.last().fail(EVENT_SOURCE_CONNECTING);

		expect(stream.status).toBe('reconnecting');
		expect(FakeEventSource.instances).toHaveLength(1);
	});

	it('rebuilds a closed source after the reconnect delay', () => {
		const pending: (() => void)[] = [];
		const stream = makeStream({
			schedule: (callback) => {
				pending.push(callback);
				return setTimeout(() => {}, 0);
			},
		});
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().emit('log', { events: [logEvent(1)] });
		FakeEventSource.last().fail(EVENT_SOURCE_CLOSED);

		expect(stream.status).toBe('reconnecting');
		expect(pending).toHaveLength(1);
		expect(FakeEventSource.instances).toHaveLength(1);

		pending[0]();
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(FakeEventSource.last().url).toBe('/api/stream?region=us-east-1&group=g');
		expect(stream.lines).toHaveLength(1);

		FakeEventSource.last().open();
		expect(stream.status).toBe('live');
	});
});

describe('LogStream pause, resume and clear', () => {
	it('buffers events while paused and flushes them on resume', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().emit('log', { events: [logEvent(1)] });
		stream.pause();
		FakeEventSource.last().emit('log', { events: [logEvent(2), logEvent(3)] });

		expect(stream.paused).toBe(true);
		expect(stream.lines.map((line) => line.message)).toEqual(['message 1']);
		expect(stream.pendingCount).toBe(2);
		expect(stream.receivedCount).toBe(3);

		stream.togglePause();
		expect(stream.paused).toBe(false);
		expect(stream.pendingCount).toBe(0);
		expect(stream.lines.map((line) => line.message)).toEqual([
			'message 1',
			'message 2',
			'message 3',
		]);
	});

	it('clear empties the buffer, the pending buffer and the counters', () => {
		const stream = makeStream();
		stream.start({ region: 'us-east-1', group: 'g' });
		FakeEventSource.last().emit('log', { events: [logEvent(1)] });
		stream.pause();
		FakeEventSource.last().emit('log', { events: [logEvent(2)] });
		stream.clear();

		expect(stream.lines).toHaveLength(0);
		expect(stream.pendingCount).toBe(0);
		expect(stream.receivedCount).toBe(0);
		expect(stream.paused).toBe(false);
	});
});

describe('historic targets', () => {
	it('sends the mode and preset in the stream URL', () => {
		const url = new URL(
			buildStreamUrl({
				region: 'af-south-1',
				group: '/aws/lambda/demo',
				mode: 'historic',
				range: '24h',
			}),
			'http://localhost',
		);
		expect(url.searchParams.get('mode')).toBe('historic');
		expect(url.searchParams.get('range')).toBe('24h');
		expect(url.searchParams.has('from')).toBe(false);
	});

	it('sends explicit bounds for a custom window', () => {
		const url = new URL(
			buildStreamUrl({
				region: 'us-east-1',
				group: '/aws/app',
				mode: 'historic',
				from: 1_700_000_000_000,
				to: 1_700_003_600_000,
			}),
			'http://localhost',
		);
		expect(url.searchParams.get('mode')).toBe('historic');
		expect(url.searchParams.get('from')).toBe('1700000000000');
		expect(url.searchParams.get('to')).toBe('1700003600000');
	});

	it('omits the mode parameter for live targets', () => {
		const url = new URL(
			buildStreamUrl({ region: 'us-east-1', group: '/aws/app' }),
			'http://localhost',
		);
		expect(url.searchParams.has('mode')).toBe(false);
		expect(url.searchParams.has('range')).toBe(false);
	});

	it('starts a historic stream and reports the window from the ready frame', () => {
		FakeEventSource.reset();
		const stream = new LogStream({ createEventSource: (url) => new FakeEventSource(url) });
		stream.start({ region: 'us-east-1', group: '/aws/app', mode: 'historic', range: '3h' });

		const source = FakeEventSource.last();
		expect(source.url).toContain('mode=historic');
		expect(source.url).toContain('range=3h');

		source.emit('ready', {
			region: 'us-east-1',
			logGroupName: '/aws/app',
			endpoint: null,
			startTime: 1_000,
			endTime: 2_000,
			mode: 'historic',
			preset: '3h',
			clamped: false,
		});
		expect(stream.ready?.mode).toBe('historic');
		expect(stream.ready?.endTime).toBe(2_000);

		source.emit('end', { reason: 'window-complete' });
		expect(stream.status).toBe('ended');
		expect(stream.endReason).toBe('window-complete');
	});
});
