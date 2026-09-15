/**
 * The registry that lets a signal end the server's open event streams.
 *
 * `closeLiveStreams` is what turns "stop the server" into something that happens
 * at once rather than after adapter-node's thirty-second grace period, so what
 * it does with the registered closers is worth pinning down on its own.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	closeLiveStreams,
	liveStreamCount,
	registerLiveStream,
} from '../src/lib/server/live-streams.ts';

describe('registerLiveStream', () => {
	it('counts the streams that are open', () => {
		const before = liveStreamCount();
		const off = registerLiveStream(() => undefined);
		expect(liveStreamCount()).toBe(before + 1);
		off();
		expect(liveStreamCount()).toBe(before);
	});

	it('closes every registered stream, and reports how many', () => {
		const first = vi.fn<() => void>();
		const second = vi.fn<() => void>();
		registerLiveStream(first);
		registerLiveStream(second);

		expect(closeLiveStreams()).toBeGreaterThanOrEqual(2);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(liveStreamCount()).toBe(0);
	});

	it('keeps closing after one stream throws', () => {
		const broken = vi.fn<() => void>(() => {
			throw new Error('already gone');
		});
		const healthy = vi.fn<() => void>();
		registerLiveStream(broken);
		registerLiveStream(healthy);

		expect(() => closeLiveStreams()).not.toThrow();
		expect(healthy).toHaveBeenCalledTimes(1);
	});

	it('forgets a stream that unregistered itself', () => {
		const close = vi.fn<() => void>();
		const off = registerLiveStream(close);
		off();

		closeLiveStreams();
		expect(close).not.toHaveBeenCalled();
	});
});
