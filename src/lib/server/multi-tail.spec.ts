import { describe, expect, test } from 'vitest';
import { mergeEndReason, mergeTails } from './multi-tail';
import type { LogEventDto } from '$lib/types';
import type { TailBatch } from './tail';

function event(message: string): LogEventDto {
	// A fixed timestamp: the tests compare events by value, so two calls in the
	// same millisecond must produce the same object.
	return { id: message, timestamp: 1_700_000_000_000, message };
}

/** Async generator over fixed batches, with an optional delay before the end. */
async function* source(
	batches: TailBatch[],
	options: { delayMs?: number; throwAfter?: boolean } = {},
): AsyncGenerator<TailBatch, void, void> {
	for (const batch of batches) {
		if (batch.type === 'end' && options.delayMs !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, options.delayMs));
		}
		yield batch;
	}
	if (options.throwAfter === true) throw new Error('boom');
}

async function collect(generator: AsyncGenerator<TailBatch, void, void>): Promise<TailBatch[]> {
	const batches: TailBatch[] = [];
	for await (const batch of generator) batches.push(batch);
	return batches;
}

describe('mergeEndReason', () => {
	test('reports the most serious reason any source gave', () => {
		expect(mergeEndReason(['window-complete'])).toBe('window-complete');
		expect(mergeEndReason(['window-complete', 'event-limit'])).toBe('event-limit');
		expect(mergeEndReason(['window-complete', 'repeated-errors', 'event-limit'])).toBe(
			'repeated-errors',
		);
		// No source reported a reason: treat the window as complete, which is what a
		// merged multi-group scan is.
		expect(mergeEndReason([])).toBe('window-complete');
	});
});

describe('mergeTails', () => {
	test('yields nothing for no sources', async () => {
		expect(await collect(mergeTails([]))).toEqual([]);
	});

	test('passes a single source through unchanged', async () => {
		const only = source([
			{ type: 'events', events: [event('a')] },
			{ type: 'end', reason: 'window-complete' },
		]);
		expect(await collect(mergeTails([only]))).toEqual([
			{ type: 'events', events: [event('a')] },
			{ type: 'end', reason: 'window-complete' },
		]);
	});

	test('interleaves events from every source and ends once, after all of them', async () => {
		const fast = source([
			{ type: 'events', events: [event('fast-1')] },
			{ type: 'events', events: [event('fast-2')] },
			{ type: 'end', reason: 'window-complete' },
		]);
		const slow = source(
			[
				{ type: 'events', events: [event('slow-1')] },
				{ type: 'end', reason: 'window-complete' },
			],
			{ delayMs: 30 },
		);

		const batches = await collect(mergeTails([fast, slow]));
		expect(batches.filter((batch) => batch.type === 'events')).toHaveLength(3);
		const ends = batches.filter((batch) => batch.type === 'end');
		expect(ends).toEqual([{ type: 'end', reason: 'window-complete' }]);

		const messages = batches
			.flatMap((batch) => (batch.type === 'events' ? batch.events.map((e) => e.message) : []))
			.toSorted();
		expect(messages).toEqual(['fast-1', 'fast-2', 'slow-1']);
	});

	test('forwards error batches without stopping the other sources', async () => {
		const broken = source([
			{ type: 'error', message: 'access denied', code: 'access-denied' },
			{ type: 'end', reason: 'repeated-errors' },
		]);
		const healthy = source([
			{ type: 'events', events: [event('ok')] },
			{ type: 'end', reason: 'window-complete' },
		]);

		const batches = await collect(mergeTails([broken, healthy]));
		expect(batches).toContainEqual({
			type: 'error',
			message: 'access denied',
			code: 'access-denied',
		});
		expect(batches).toContainEqual({ type: 'events', events: [event('ok')] });
		expect(batches.at(-1)).toEqual({ type: 'end', reason: 'repeated-errors' });
	});

	test('ends when a source throws after producing batches', async () => {
		const exploding = source([{ type: 'events', events: [event('first')] }], { throwAfter: true });
		const other = source([
			{ type: 'events', events: [event('second')] },
			{ type: 'end', reason: 'window-complete' },
		]);
		const batches = await collect(mergeTails([exploding, other]));
		expect(batches.filter((batch) => batch.type === 'events').length).toBeGreaterThanOrEqual(1);
		expect(batches.at(-1)).toEqual({ type: 'end', reason: 'window-complete' });
	});

	test('keeps streaming while one source is still working', async () => {
		// The merged stream must not wait for the slowest source to emit anything.
		const quick = source([{ type: 'events', events: [event('quick')] }], { delayMs: 60 });
		const slow = source(
			[
				{ type: 'events', events: [event('slow')] },
				{ type: 'end', reason: 'window-complete' },
			],
			{ delayMs: 200 },
		);

		const seen: string[] = [];
		for await (const batch of mergeTails([quick, slow])) {
			if (batch.type !== 'events') continue;
			seen.push(...batch.events.map((e) => e.message));
		}
		expect(seen).toEqual(['quick', 'slow']);
	});

	test('does not drop batches queued after an early-finishing source', async () => {
		// The short source ends before the long one has produced anything, so its
		// end marker sits ahead of the long source's batches in the queue.
		const short = source([{ type: 'end', reason: 'window-complete' }]);
		const long = source(
			[
				{ type: 'events', events: [event('late-1')] },
				{ type: 'events', events: [event('late-2')] },
				{ type: 'end', reason: 'window-complete' },
			],
			{ delayMs: 25 },
		);

		const batches = await collect(mergeTails([short, long]));
		const messages = batches.flatMap((batch) =>
			batch.type === 'events' ? batch.events.map((entry) => entry.message) : [],
		);
		expect(messages).toEqual(['late-1', 'late-2']);
		expect(batches.filter((batch) => batch.type === 'end')).toHaveLength(1);
	});
});
