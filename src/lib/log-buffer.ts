/**
 * Pure client-side log storage and filtering for the watch-tail UI.
 *
 * Design decisions (kept in one place so the UI stays predictable):
 *
 * - The visible buffer is a fixed-capacity ring buffer. When it is full the oldest line is
 *   dropped, so memory stays bounded while tailing a busy group.
 * - Pausing keeps the SSE connection open and keeps receiving events. Incoming events are held in
 *   a bounded pending buffer instead of the visible buffer, and are flushed in arrival order when
 *   the user resumes.
 */

import { findJsonInMessage } from './log-format';
import type { LogEventDto } from './types';

/** Maximum number of lines kept in the visible client buffer. */
export const DEFAULT_CAPACITY = 5000;

/** Severity used for colouring log lines and for the archive's `level` column. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Where a level came from: the payload declared it, or the text was matched. */
type LevelSource = 'json' | 'text';

/**
 * A detected level plus its provenance.
 *
 * `level: null` means the line carried no usable signal. That distinction
 * matters: "no level found" is not the same claim as "the app said info", and
 * the archive stores it as `NULL`.
 */
export type DetectedLevel = { level: LogLevel | null; source: LevelSource | null };

const ERROR_PATTERN =
	/\b(ERROR|FATAL|CRITICAL|CRIT|PANIC|EXCEPTION|TRACEBACK|SEVERE|FAILED|FAILURE)\b/;
const WARN_PATTERN = /\b(WARN|WARNING)\b/;
const DEBUG_PATTERN = /\b(DEBUG|TRACE|VERBOSE)\b/;

/** Payload keys checked, in order, for a level the producer declared. */
export const LEVEL_KEYS = ['level', 'severity', 'lvl', 'logLevel', 'log_level'] as const;

/**
 * Declared level words mapped onto the four levels the UI knows.
 *
 * The vocabulary is deliberately small: `fatal` and `critical` are errors to
 * everyone reading a log, and collapsing them keeps the filter and the colours
 * honest instead of inventing levels nothing else understands.
 */
const LEVEL_WORDS: Record<string, LogLevel> = {
	trace: 'debug',
	verbose: 'debug',
	debug: 'debug',
	info: 'info',
	information: 'info',
	notice: 'info',
	note: 'info',
	warn: 'warn',
	warning: 'warn',
	error: 'error',
	err: 'error',
	exception: 'error',
	fatal: 'error',
	critical: 'error',
	crit: 'error',
	panic: 'error',
	severe: 'error',
	alert: 'error',
	emergency: 'error',
};

/**
 * Bunyan/pino style numeric levels.
 *
 * Only exact known values are mapped: a bare number such as `{"level":0}` means
 * different things in different loggers, so an unknown number falls through to
 * the text heuristic instead of being guessed at.
 */
const NUMERIC_LEVELS: Record<number, LogLevel> = {
	10: 'debug',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error',
	60: 'error',
};

/** True when a value is one of the four known levels. */
export function isLogLevel(value: unknown): value is LogLevel {
	return value === 'error' || value === 'warn' || value === 'info' || value === 'debug';
}

/** Converts one declared JSON value into a level, or `null` when unrecognised. */
export function levelFromDeclared(value: unknown): LogLevel | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return NUMERIC_LEVELS[value] ?? null;
	}
	if (typeof value !== 'string') return null;
	const word = value.trim().toLowerCase();
	if (word.length === 0) return null;
	return LEVEL_WORDS[word] ?? null;
}

/**
 * Level the payload declares, when the line carries a JSON object with a known
 * level key. Whole messages and "prefix then payload" lines are both handled,
 * by the same parser the viewer uses to pretty-print JSON.
 */
function declaredLevel(message: string): LogLevel | null {
	const payload = findJsonInMessage(message);
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
	const record = payload as Record<string, unknown>;
	for (const key of LEVEL_KEYS) {
		const level = levelFromDeclared(record[key]);
		if (level !== null) return level;
	}
	return null;
}

/**
 * Severity ranks, highest first, with `unknown` below every real level.
 *
 * One ordered table feeds the JavaScript helpers and the SQL the archive runs,
 * so "most critical" means exactly the same thing in the chart, in the log view
 * and in DuckDB. Insertion order is severity order.
 */
export const LEVEL_RANK: Record<LogLevel | 'unknown', number> = {
	error: 4,
	warn: 3,
	info: 2,
	debug: 1,
	unknown: 0,
};

/** Rank of a level; a missing level ranks as `unknown`. */
export function levelRank(level: LogLevel | 'unknown' | null | undefined): number {
	return level === null || level === undefined ? LEVEL_RANK.unknown : LEVEL_RANK[level];
}

/**
 * Worst level in a set of levels, or `null` when none of them has a level.
 *
 * This is what a request id group is coloured by: a group with one error line
 * and twenty info lines is an error, because that is what a reader needs to see.
 */
export function mostCriticalLevel(
	levels: Iterable<LogLevel | 'unknown' | null | undefined>,
): LogLevel | null {
	let best: LogLevel | null = null;
	let bestRank = -1;
	for (const level of levels) {
		if (level === null || level === undefined || level === 'unknown') continue;
		const rank = LEVEL_RANK[level];
		if (rank > bestRank) {
			bestRank = rank;
			best = level;
		}
	}
	return best;
}

/**
 * Payload keys checked, in order, for a request id the producer declared.
 *
 * The list is deliberately about the *request*: a trace id, a session id or a
 * tenant id names something else and must not collapse unrelated lines.
 */
export const REQUEST_ID_KEYS = [
	'requestId',
	'request_id',
	'requestID',
	'reqId',
	'req_id',
	'awsRequestId',
	'aws_request_id',
	'xRequestId',
	'x_request_id',
	'x-request-id',
	'X-Request-Id',
] as const;

/** Values that look like an id but mean "there is none". */
const REQUEST_ID_PLACEHOLDERS = new Set([
	'none',
	'null',
	'undefined',
	'n/a',
	'na',
	'unknown',
	'test',
	'-',
	'{{requestid}}',
	'${requestid}',
]);

/** Shortest value treated as a request id, so `id: 1` is not a grouping key. */
const REQUEST_ID_MIN_LENGTH = 4;

/** Characters a request id is made of; anything with a space is not an id. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:=-]*$/;

/**
 * `RequestId: 1234-abcd`, `request_id=abc.def`, `x-request-id: 8f2c`: the
 * separators and the casing both vary, so one pattern covers them.
 *
 * A bare UUID is deliberately *not* matched. Plenty of log lines carry a
 * correlation id, a span id or an uploaded file's id, and grouping by one of
 * those would invent requests that never existed.
 */
const REQUEST_ID_TEXT = /\brequest[\s_-]?id\b\s*[:=]\s*"?([A-Za-z0-9][A-Za-z0-9._:=-]*)"?/i;

/** Trims trailing punctuation a sentence adds after an id. */
function cleanRequestId(value: string): string | null {
	const trimmed = value.replace(/[.,;:]+$/, '').trim();
	if (trimmed.length < REQUEST_ID_MIN_LENGTH) return null;
	if (REQUEST_ID_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
	return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Request id the payload declares, when the line carries a JSON object. */
function declaredRequestId(message: string): string | null {
	const payload = findJsonInMessage(message);
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
	const record = payload as Record<string, unknown>;
	for (const key of REQUEST_ID_KEYS) {
		const value = record[key];
		if (typeof value === 'string') {
			const cleaned = cleanRequestId(value);
			if (cleaned !== null) return cleaned;
		}
		// Numbers are legitimate ids in some frameworks, and never placeholders.
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return null;
}

/**
 * Detects the request id of a log line, or returns `null` when it has none.
 *
 * A declared payload key wins; the text form is the fallback for the many logs
 * that print their id instead of emitting JSON. Both paths return the id
 * verbatim, because it is an identifier - folding case would merge distinct ids
 * on the one hand and lie about what the log said on the other.
 */
export function detectRequestId(message: string): string | null {
	const text = message ?? '';
	if (text === '') return null;
	const declared = declaredRequestId(text);
	if (declared !== null) return declared;
	const match = REQUEST_ID_TEXT.exec(text);
	return match === null ? null : cleanRequestId(match[1] ?? '');
}

/**
 * Detects the severity of a log line.
 *
 * A level the payload declares wins, because it is a statement of fact; the
 * text heuristic is the fallback for the many logs that declare nothing. The
 * heuristic matches level words anywhere in the line, so
 * `{"level":"info","msg":"retry after error count 0"}` is `info`, not `error`.
 */
export function detectLevelWithSource(message: string): DetectedLevel {
	const declared = declaredLevel(message ?? '');
	if (declared !== null) return { level: declared, source: 'json' };
	const upper = (message ?? '').toUpperCase();
	if (ERROR_PATTERN.test(upper)) return { level: 'error', source: 'text' };
	if (WARN_PATTERN.test(upper)) return { level: 'warn', source: 'text' };
	if (DEBUG_PATTERN.test(upper)) return { level: 'debug', source: 'text' };
	return { level: null, source: null };
}

/**
 * Guesses the severity of a log line from its text, or returns `null` when the
 * line carries no signal at all (a stack-trace continuation, for example).
 */
export function detectLevel(message: string): LogLevel | null {
	return detectLevelWithSource(message).level;
}

/** Level of an event: what the server detected, else a guess from the text. */
export function effectiveLevel(event: LogEventDto): LogLevel | null {
	return event.level !== undefined ? event.level : detectLevel(event.message);
}

/** True when an event passes a level filter; a `null` filter accepts every line. */
export function matchesLevel(event: LogEventDto, level: LogLevel | null): boolean {
	return level === null || effectiveLevel(event) === level;
}

/** Filters events by level, keeping every line when `level` is `null`. */
export function filterByLevel(
	events: readonly LogEventDto[],
	level: LogLevel | null,
): LogEventDto[] {
	if (level === null) return events.slice();
	return events.filter((event) => matchesLevel(event, level));
}

/** Tailwind text colour class for a severity; an unknown level stays neutral. */
export function levelColorClass(level: LogLevel | null): string {
	switch (level) {
		case 'error':
			return 'text-red-400';
		case 'warn':
			return 'text-amber-300';
		case 'debug':
			return 'text-neutral-500';
		default:
			return 'text-neutral-200';
	}
}

/** Stable key for rendering a log line, since event ids can repeat or be missing. */
export function eventKey(event: LogEventDto, index: number): string {
	return `${event.id ?? 'no-id'}:${event.timestamp}:${index}`;
}

/** Case-insensitive substring match over the message and the stream name. */
export function matchesFilter(event: LogEventDto, query: string): boolean {
	const needle = (query ?? '').trim().toLowerCase();
	if (needle === '') return true;
	const haystack = `${event.message ?? ''} ${event.streamName ?? ''}`.toLowerCase();
	return haystack.includes(needle);
}

/** Returns the events matching `query`, in arrival order. */
export function filterEvents(events: readonly LogEventDto[], query: string): LogEventDto[] {
	if ((query ?? '').trim() === '') return events.slice();
	return events.filter((event) => matchesFilter(event, query));
}

/** Creates an array of `length` undefined slots. */
function emptySlots<T>(length: number): (T | undefined)[] {
	return Array.from<T | undefined>({ length });
}

/**
 * Fixed-capacity ring buffer that overwrites the oldest item once it is full.
 */
export class LogRingBuffer<T> {
	/** Maximum number of items kept. */
	readonly capacity: number;
	#items: (T | undefined)[];
	#start = 0;
	#size = 0;
	#dropped = 0;

	constructor(capacity: number = DEFAULT_CAPACITY) {
		if (!Number.isInteger(capacity) || capacity <= 0) {
			throw new RangeError(`capacity must be a positive integer, received ${capacity}`);
		}
		this.capacity = capacity;
		this.#items = emptySlots<T>(capacity);
	}

	/** Number of items currently stored. */
	get size(): number {
		return this.#size;
	}

	/** Number of items discarded because the buffer was full. */
	get dropped(): number {
		return this.#dropped;
	}

	/** True when the buffer holds `capacity` items. */
	get full(): boolean {
		return this.#size === this.capacity;
	}

	/** Appends one item, dropping the oldest item when the buffer is full. */
	push(item: T): void {
		if (this.#size === this.capacity) {
			this.#dropped += 1;
			this.#start = (this.#start + 1) % this.capacity;
			this.#size -= 1;
		}
		const index = (this.#start + this.#size) % this.capacity;
		this.#items[index] = item;
		this.#size += 1;
	}

	/** Appends several items in order. */
	pushMany(items: Iterable<T>): void {
		for (const item of items) this.push(item);
	}

	/** Copies the stored items into an array ordered oldest to newest. */
	toArray(): T[] {
		const output = emptySlots<T>(this.#size);
		for (let offset = 0; offset < this.#size; offset += 1) {
			output[offset] = this.#items[(this.#start + offset) % this.capacity];
		}
		// Every slot below `size` was filled by push().
		return output as T[];
	}

	/** Oldest stored item, or `undefined` when empty. */
	first(): T | undefined {
		return this.#size === 0 ? undefined : this.#items[this.#start];
	}

	/** Newest stored item, or `undefined` when empty. */
	last(): T | undefined {
		return this.#size === 0
			? undefined
			: this.#items[(this.#start + this.#size - 1) % this.capacity];
	}

	/** Removes every item and resets the dropped counter. */
	clear(): void {
		this.#items = emptySlots<T>(this.capacity);
		this.#start = 0;
		this.#size = 0;
		this.#dropped = 0;
	}
}

/**
 * Log store used by the UI: a visible ring buffer plus a pending buffer that fills up while the
 * view is paused. `push()` never drops silent data, it either appends to the visible buffer or to
 * the pending buffer; `resume()` moves the pending events into the visible buffer in order.
 */
export class LogStore {
	readonly buffer: LogRingBuffer<LogEventDto>;
	#pending: LogRingBuffer<LogEventDto>;
	#paused = false;

	constructor(capacity: number = DEFAULT_CAPACITY) {
		this.buffer = new LogRingBuffer<LogEventDto>(capacity);
		this.#pending = new LogRingBuffer<LogEventDto>(capacity);
	}

	/** True when incoming events are buffered instead of appended to the visible buffer. */
	get paused(): boolean {
		return this.#paused;
	}

	/** Number of visible lines. */
	get size(): number {
		return this.buffer.size;
	}

	/** Number of lines held back while paused. */
	get pendingCount(): number {
		return this.#pending.size;
	}

	/** Number of visible lines dropped because the buffer was full. */
	get droppedCount(): number {
		return this.buffer.dropped;
	}

	/** Appends events to the visible buffer, or holds them back while paused. */
	push(events: readonly LogEventDto[]): void {
		if (this.#paused) {
			this.#pending.pushMany(events);
			return;
		}
		this.buffer.pushMany(events);
	}

	/** Pauses or resumes appending. Resuming flushes the pending events immediately. */
	setPaused(paused: boolean): LogEventDto[] {
		if (paused === this.#paused) return [];
		this.#paused = paused;
		return paused ? [] : this.flush();
	}

	/** Pauses appending to the visible buffer. */
	pause(): void {
		this.#paused = true;
	}

	/** Resumes appending and returns the events flushed from the pending buffer. */
	resume(): LogEventDto[] {
		this.#paused = false;
		return this.flush();
	}

	/** Moves every pending event into the visible buffer, oldest first. */
	flush(): LogEventDto[] {
		const flushed = this.#pending.toArray();
		this.#pending.clear();
		this.buffer.pushMany(flushed);
		return flushed;
	}

	/** Copies the visible lines, oldest first. */
	toArray(): LogEventDto[] {
		return this.buffer.toArray();
	}

	/** Empties the visible buffer and discards pending events. */
	clear(): void {
		this.buffer.clear();
		this.#pending.clear();
	}
}
