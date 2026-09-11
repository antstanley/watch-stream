/**
 * Reactive SSE client for `GET /api/stream`.
 *
 * The class owns the connection lifecycle and mirrors the stream onto Svelte runes so components
 * can render it directly. The `EventSource` is injectable so jsdom tests can drive it with a fake.
 *
 * Reconnect policy: the browser's `EventSource` reconnects by itself while `readyState` is
 * `CONNECTING`, so we only rebuild the source when it reaches `CLOSED`. Buffer contents survive a
 * reconnect; they are only reset by `start()` or `clear()`.
 */

import { DEFAULT_CAPACITY, LogStore } from './log-buffer';
import type { LogMode } from './time-range';
import type {
	LogEventDto,
	StreamEndPayload,
	StreamErrorPayload,
	StreamLogPayload,
	StreamPingPayload,
	StreamReadyPayload,
	StreamState,
} from './types';

/** `EventSource.readyState` value for a connecting socket. */
export const EVENT_SOURCE_CONNECTING = 0;
/** `EventSource.readyState` value for an open socket. */
export const EVENT_SOURCE_OPEN = 1;
/** `EventSource.readyState` value for a closed socket. */
export const EVENT_SOURCE_CLOSED = 2;

/**
 * Minimal `EventSource` surface used by {@link LogStream}.
 * The real DOM `EventSource` satisfies this shape, which keeps it injectable.
 *
 * Connection failures are delivered through the same `error` event as server-sent `error` payloads,
 * so a single listener tells them apart by payload: no payload means the connection dropped.
 */
export interface EventSourceLike {
	readonly readyState: number;
	/** `open`, `error` and the five stream events are all registered as listeners. */
	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
	removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
	close(): void;
}

/** Creates a connection for a URL. */
export type EventSourceFactory = (url: string) => EventSourceLike;

/** Timer handle type used by the reconnect scheduler. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** What to tail. */
export type StreamTarget = {
	region: string;
	group: string;
	/** `live` (default) tails new events; `historic` scans a fixed window. */
	mode?: LogMode;
	/** Preset window for historic mode, for example `24h`. */
	range?: string;
	/** Custom window start: epoch ms or ISO 8601. */
	from?: number | string;
	/** Custom window end: epoch ms or ISO 8601. */
	to?: number | string;
	/** CloudWatch filter pattern passed through to the server. */
	filterPattern?: string;
	/** Epoch ms, ISO 8601 or a duration such as `15m`. */
	startTime?: number | string;
	/** Duration used when `startTime` is absent, for example `5m`. */
	lookback?: string;
	/** Poll interval in ms, clamped by the server to 250..15000. */
	poll?: number;
};

/** Options for {@link LogStream}. */
export type LogStreamOptions = {
	/** Defaults to the real `EventSource`; tests inject a fake. */
	createEventSource?: EventSourceFactory;
	/** Visible buffer cap; defaults to {@link DEFAULT_CAPACITY}. */
	capacity?: number;
	/** Delay before rebuilding a closed source; defaults to 1000 ms. */
	reconnectDelayMs?: number;
	/** Builds the SSE URL for a target; defaults to {@link buildStreamUrl}. */
	url?: (target: StreamTarget) => string;
	/** Reconnect scheduler, injectable so tests need no timers. */
	schedule?: (callback: () => void, delayMs: number) => TimerHandle;
	/** Cancels a scheduled reconnect. */
	cancel?: (handle: TimerHandle) => void;
};

/** Creates the real browser `EventSource`. */
/** Default factory: the browser's own `EventSource`. */
function createBrowserEventSource(url: string): EventSourceLike {
	return new EventSource(url);
}

/** Builds the `/api/stream` SSE URL for a target. `base` allows an absolute URL in tests. */
export function buildStreamUrl(target: StreamTarget, base = ''): string {
	const search = new URLSearchParams();
	search.set('region', target.region);
	search.set('group', target.group);
	if (target.filterPattern) search.set('filterPattern', target.filterPattern);
	if (target.mode === 'historic') {
		search.set('mode', 'historic');
		if (target.range) search.set('range', target.range);
		if (target.from !== undefined && target.from !== '') search.set('from', String(target.from));
		if (target.to !== undefined && target.to !== '') search.set('to', String(target.to));
	} else if (target.mode === 'live') {
		search.set('mode', 'live');
	}
	if (target.startTime !== undefined && target.startTime !== '') {
		search.set('startTime', String(target.startTime));
	}
	if (target.lookback) search.set('lookback', target.lookback);
	if (typeof target.poll === 'number' && Number.isFinite(target.poll)) {
		search.set('poll', String(target.poll));
	}
	return `${base}/api/stream?${search.toString()}`;
}

/** Parses an SSE payload, returning `null` instead of throwing on malformed JSON. */
function parsePayload<T>(data: string): T | null {
	try {
		return JSON.parse(data) as T;
	} catch {
		return null;
	}
}

/**
 * Live view over one CloudWatch log group.
 *
 * Pause policy: pausing keeps the connection open and keeps receiving events; those events are
 * held in a pending buffer and flushed into the visible buffer on resume.
 */
export class LogStream {
	/** Connection status shown by the status badge. */
	status = $state<StreamState>('idle');
	/** Last server-side or transport error, or `null`. */
	lastError = $state<StreamErrorPayload | null>(null);
	/** Payload of the last `ready` event. */
	ready = $state<StreamReadyPayload | null>(null);
	/** Current target, or `null` after `stop()`. */
	target = $state<StreamTarget | null>(null);
	/** Visible log lines, oldest first, capped by the buffer capacity. */
	lines = $state.raw<LogEventDto[]>([]);
	/** Total number of events received since the last reset. */
	receivedCount = $state(0);
	/** Lines dropped because the visible buffer was full. */
	droppedCount = $state(0);
	/** Lines held back while paused. */
	pendingCount = $state(0);
	/** True when the visible buffer is frozen and events are buffered. */
	paused = $state(false);
	/** Timestamp of the last `ping` or `log` event. */
	lastEventAt = $state<number | null>(null);
	/** Reason given by the last `end` event. */
	endReason = $state<string | null>(null);

	#store: LogStore;
	#source: EventSourceLike | null = null;
	#listeners: {
		source: EventSourceLike;
		type: string;
		handler: (event: MessageEvent<string>) => void;
	}[] = [];
	#reconnectTimer: TimerHandle | null = null;
	#createEventSource: EventSourceFactory;
	#reconnectDelayMs: number;
	#url: (target: StreamTarget) => string;
	#schedule: (callback: () => void, delayMs: number) => TimerHandle;
	#cancel: (handle: TimerHandle) => void;

	constructor(options: LogStreamOptions = {}) {
		this.#store = new LogStore(options.capacity ?? DEFAULT_CAPACITY);
		this.#createEventSource = options.createEventSource ?? createBrowserEventSource;
		this.#reconnectDelayMs = options.reconnectDelayMs ?? 1000;
		this.#url = options.url ?? ((target) => buildStreamUrl(target));
		this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle));
	}

	/** Starts tailing a target, replacing any previous stream and clearing the buffer. */
	start(target: StreamTarget): void {
		this.#closeSource();
		this.#clearReconnect();
		this.clear();
		this.status = 'connecting';
		this.lastError = null;
		this.ready = null;
		this.endReason = null;
		this.target = { ...target };
		this.#connect(false);
	}

	/** Stops tailing and forgets the target; the buffered lines stay visible. */
	stop(): void {
		this.#clearReconnect();
		this.#closeSource();
		this.target = null;
		this.status = 'idle';
	}

	/** Freezes the visible buffer; incoming events are held until {@link resume}. */
	pause(): void {
		this.#store.pause();
		this.paused = true;
	}

	/** Thaws the visible buffer and flushes the events held while paused. */
	resume(): void {
		this.#store.resume();
		this.paused = false;
		this.#syncStore();
	}

	/** Pauses or resumes, depending on the current state. */
	togglePause(): void {
		if (this.paused) this.resume();
		else this.pause();
	}

	/** Empties the visible buffer, the pending buffer and the counters. */
	clear(): void {
		this.#store.clear();
		this.paused = false;
		this.lines = [];
		this.receivedCount = 0;
		this.droppedCount = 0;
		this.pendingCount = 0;
	}

	/** Number of visible lines. */
	get size(): number {
		return this.#store.size;
	}

	/** Opens a connection for the current target. */
	#connect(retry: boolean): void {
		const target = this.target;
		if (target === null) return;
		this.#closeSource();
		this.status = retry ? 'reconnecting' : 'connecting';

		let source: EventSourceLike;
		try {
			source = this.#createEventSource(this.#url(target));
		} catch (error) {
			this.status = 'error';
			this.lastError = { message: error instanceof Error ? error.message : String(error) };
			return;
		}

		this.#source = source;
		this.#listen(source, 'open', () => {
			this.status = 'live';
			this.lastError = null;
		});
		this.#listen(source, 'error', (event) => this.#handleErrorEvent(event));
		this.#listen(source, 'ready', (event) => this.#handleReady(event));
		this.#listen(source, 'log', (event) => this.#handleLog(event));
		this.#listen(source, 'ping', (event) => this.#handlePing(event));
		this.#listen(source, 'end', (event) => this.#handleEnd(event));
	}

	/** Registers a named-event listener and remembers it for cleanup. */
	#listen(
		source: EventSourceLike,
		type: string,
		handler: (event: MessageEvent<string>) => void,
	): void {
		source.addEventListener(type, handler);
		this.#listeners.push({ source, type, handler });
	}

	/** Detaches listeners and closes the current connection. */
	#closeSource(): void {
		for (const listener of this.#listeners) {
			listener.source.removeEventListener(listener.type, listener.handler);
		}
		this.#listeners = [];
		this.#source?.close();
		this.#source = null;
	}

	/**
	 * Handles every `error` event. A payload means the server reported a problem; an empty payload
	 * means the connection dropped, which {@link #handleTransportError} deals with.
	 */
	#handleErrorEvent(event: MessageEvent<string>): void {
		const data = typeof event.data === 'string' ? event.data.trim() : '';
		if (data === '') {
			this.#handleTransportError();
			return;
		}
		this.lastError = parsePayload<StreamErrorPayload>(data) ?? { message: data };
		this.status = 'error';
	}

	/**
	 * Handles a transport failure. While the source is still `CONNECTING` the browser keeps retrying
	 * on its own; a `CLOSED` source is rebuilt after {@link LogStreamOptions.reconnectDelayMs}.
	 */
	#handleTransportError(): void {
		const source = this.#source;
		if (source === null) return;
		this.status = 'reconnecting';
		if (source.readyState === EVENT_SOURCE_CLOSED) this.#scheduleReconnect();
	}

	/** Schedules one reconnect attempt, unless one is already pending. */
	#scheduleReconnect(): void {
		if (this.#reconnectTimer !== null) return;
		this.#reconnectTimer = this.#schedule(() => {
			this.#reconnectTimer = null;
			if (this.target !== null) this.#connect(true);
		}, this.#reconnectDelayMs);
	}

	/** Drops a pending reconnect attempt. */
	#clearReconnect(): void {
		if (this.#reconnectTimer === null) return;
		this.#cancel(this.#reconnectTimer);
		this.#reconnectTimer = null;
	}

	/** Marks the stream as live after receiving data. */
	#markLive(): void {
		this.lastEventAt = Date.now();
		if (this.status !== 'ended') this.status = 'live';
	}

	/** Copies buffer state onto the reactive fields. */
	#syncStore(): void {
		this.lines = this.#store.toArray();
		this.pendingCount = this.#store.pendingCount;
		this.droppedCount = this.#store.droppedCount;
	}

	#handleReady(event: MessageEvent<string>): void {
		const payload = parsePayload<StreamReadyPayload>(event.data);
		if (payload !== null) this.ready = payload;
		this.#markLive();
	}

	#handleLog(event: MessageEvent<string>): void {
		const payload = parsePayload<StreamLogPayload>(event.data);
		const events = payload !== null && Array.isArray(payload.events) ? payload.events : [];
		if (events.length === 0) return;
		this.#store.push(events);
		this.#syncStore();
		this.receivedCount += events.length;
		this.#markLive();
	}

	#handlePing(event: MessageEvent<string>): void {
		const payload = parsePayload<StreamPingPayload>(event.data);
		this.lastEventAt = payload?.at ?? Date.now();
		if (this.status !== 'ended') this.status = 'live';
	}

	#handleEnd(event: MessageEvent<string>): void {
		const payload = parsePayload<StreamEndPayload>(event.data);
		this.endReason = payload?.reason ?? null;
		this.status = 'ended';
		this.#clearReconnect();
		this.#closeSource();
	}
}
