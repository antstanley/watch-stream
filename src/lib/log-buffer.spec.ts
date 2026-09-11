import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CAPACITY,
	LogRingBuffer,
	LogStore,
	detectLevel,
	eventKey,
	filterEvents,
	levelColorClass,
	matchesFilter,
} from './log-buffer';
import type { LogEventDto } from './types';

/** Builds a log event with a generated message. */
function event(index: number, message = `line ${index}`): LogEventDto {
	return { id: `id-${index}`, timestamp: 1_700_000_000_000 + index, message };
}

describe('LogRingBuffer', () => {
	it('appends items in order', () => {
		const buffer = new LogRingBuffer<number>(3);
		buffer.push(1);
		buffer.pushMany([2, 3]);
		expect(buffer.size).toBe(3);
		expect(buffer.toArray()).toEqual([1, 2, 3]);
		expect(buffer.full).toBe(true);
	});

	it('drops the oldest item when full and counts the drops', () => {
		const buffer = new LogRingBuffer<number>(3);
		buffer.pushMany([1, 2, 3, 4, 5]);
		expect(buffer.toArray()).toEqual([3, 4, 5]);
		expect(buffer.size).toBe(3);
		expect(buffer.dropped).toBe(2);
	});

	it('exposes the oldest and newest items', () => {
		const buffer = new LogRingBuffer<number>(2);
		expect(buffer.first()).toBeUndefined();
		expect(buffer.last()).toBeUndefined();
		buffer.pushMany([1, 2, 3]);
		expect(buffer.first()).toBe(2);
		expect(buffer.last()).toBe(3);
	});

	it('clears items and the dropped counter', () => {
		const buffer = new LogRingBuffer<number>(2);
		buffer.pushMany([1, 2, 3]);
		buffer.clear();
		expect(buffer.size).toBe(0);
		expect(buffer.dropped).toBe(0);
		expect(buffer.toArray()).toEqual([]);
	});

	it('rejects a non-positive capacity', () => {
		expect(() => new LogRingBuffer<number>(0)).toThrow(RangeError);
	});
});

describe('LogStore', () => {
	it('keeps at most the configured capacity and drops the oldest lines', () => {
		const store = new LogStore(3);
		store.push([event(1), event(2)]);
		store.push([event(3), event(4)]);
		expect(store.size).toBe(3);
		expect(store.droppedCount).toBe(1);
		expect(store.toArray().map((item) => item.message)).toEqual(['line 2', 'line 3', 'line 4']);
	});

	it('uses a 5000 line capacity by default', () => {
		const store = new LogStore();
		store.push(Array.from({ length: DEFAULT_CAPACITY + 10 }, (_value, index) => event(index)));
		expect(store.size).toBe(DEFAULT_CAPACITY);
		expect(store.droppedCount).toBe(10);
	});

	it('buffers events while paused and flushes them on resume', () => {
		const store = new LogStore(10);
		store.push([event(1)]);
		store.pause();
		store.push([event(2), event(3)]);

		expect(store.paused).toBe(true);
		expect(store.size).toBe(1);
		expect(store.pendingCount).toBe(2);

		const flushed = store.resume();
		expect(flushed.map((item) => item.message)).toEqual(['line 2', 'line 3']);
		expect(store.paused).toBe(false);
		expect(store.pendingCount).toBe(0);
		expect(store.toArray().map((item) => item.message)).toEqual(['line 1', 'line 2', 'line 3']);
	});

	it('flushes through setPaused just like resume', () => {
		const store = new LogStore(10);
		store.setPaused(true);
		store.push([event(1)]);
		const flushed = store.setPaused(false);
		expect(flushed).toHaveLength(1);
		expect(store.size).toBe(1);
	});

	it('bounds the pending buffer while paused', () => {
		const store = new LogStore(2);
		store.pause();
		store.push([event(1), event(2), event(3)]);
		expect(store.pendingCount).toBe(2);
		store.resume();
		expect(store.toArray().map((item) => item.message)).toEqual(['line 2', 'line 3']);
	});

	it('clears visible and pending events', () => {
		const store = new LogStore(10);
		store.push([event(1)]);
		store.pause();
		store.push([event(2)]);
		store.clear();
		expect(store.size).toBe(0);
		expect(store.pendingCount).toBe(0);
	});
});

describe('detectLevel', () => {
	it('detects errors', () => {
		expect(detectLevel('ERROR could not connect')).toBe('error');
		expect(detectLevel('Unhandled Exception: boom')).toBe('error');
		expect(detectLevel('{"level":"fatal","msg":"bye"}')).toBe('error');
	});

	it('detects warnings', () => {
		expect(detectLevel('WARN retrying in 2s')).toBe('warn');
		expect(detectLevel('{"level":"warning"}')).toBe('warn');
	});

	it('detects debug lines', () => {
		expect(detectLevel('DEBUG cache hit')).toBe('debug');
		expect(detectLevel('trace: entering handler')).toBe('debug');
	});

	it('defaults to info', () => {
		expect(detectLevel('server started on port 3000')).toBe('info');
		expect(detectLevel('the user warned us')).toBe('info');
	});

	it('prefers error over debug when both appear', () => {
		expect(detectLevel('DEBUG failed to parse payload')).toBe('error');
	});
});

describe('levelColorClass', () => {
	it('maps every level to a distinct colour class', () => {
		const classes = (['error', 'warn', 'info', 'debug'] as const).map(levelColorClass);
		expect(new Set(classes).size).toBe(4);
		expect(levelColorClass('error')).toContain('red');
	});
});

describe('filterEvents', () => {
	it('matches the message case-insensitively', () => {
		expect(matchesFilter(event(1, 'Connection refused'), 'CONNECTION')).toBe(true);
		expect(matchesFilter(event(1, 'Connection refused'), 'timeout')).toBe(false);
	});

	it('matches the stream name too', () => {
		const withStream: LogEventDto = { ...event(1), streamName: 'checkout-worker' };
		expect(matchesFilter(withStream, 'worker')).toBe(true);
	});

	it('returns everything for an empty query', () => {
		const events = [event(1), event(2, 'other')];
		expect(filterEvents(events, '   ')).toHaveLength(2);
	});

	it('keeps only matching events and ignores case', () => {
		const events = [event(1, 'accepted request'), event(2, 'dropped request'), event(3, 'ok')];
		expect(filterEvents(events, 'REQUEST').map((item) => item.message)).toEqual([
			'accepted request',
			'dropped request',
		]);
		expect(filterEvents(events, 'DROPPED')).toHaveLength(1);
	});

	it('does not mutate the input array', () => {
		const events = [event(1, 'alpha'), event(2, 'beta')];
		filterEvents(events, 'alpha');
		expect(events).toHaveLength(2);
	});
});

describe('eventKey', () => {
	it('combines the event id, timestamp and index', () => {
		expect(eventKey(event(1), 0)).toBe('id-1:1700000000001:0');
	});

	it('handles a missing id', () => {
		const anonymous: LogEventDto = { id: null, timestamp: 5, message: 'x' };
		expect(eventKey(anonymous, 2)).toBe('no-id:5:2');
	});
});
