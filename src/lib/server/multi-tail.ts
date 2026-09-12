/**
 * Merges several tail generators into one batch stream.
 *
 * A view can hold more than one log group, and CloudWatch Logs reads one group
 * per call, so the route runs a tail per group and merges them here. Batches are
 * forwarded as they arrive rather than round-robin, so a busy group is not held
 * back by a quiet one. The merged stream ends once every source has ended, with
 * the most serious reason any of them reported.
 */
import type { TailBatch, TailEndReason } from './tail';

/** Events-payload batch reasons, worst first. */
const END_PRECEDENCE = ['repeated-errors', 'event-limit', 'window-complete'] as const;

/** Picks the most serious end reason from the sources. */
export function mergeEndReason(reasons: readonly string[]): TailEndReason {
	for (const candidate of END_PRECEDENCE) {
		if (reasons.includes(candidate)) return candidate;
	}
	return 'window-complete';
}

/**
 * Yields every batch of every source, then one `end`.
 *
 * A failing source yields its own `error` batch; it never cancels the others, so
 * one unreadable group does not silence the rest of the view.
 */
export async function* mergeTails(
	sources: readonly AsyncGenerator<TailBatch, void, void>[],
): AsyncGenerator<TailBatch, void, void> {
	if (sources.length === 0) return;
	if (sources.length === 1) {
		yield* sources[0] as AsyncGenerator<TailBatch, void, void>;
		return;
	}

	type Item = { batch: TailBatch } | { done: true };
	const queue: Item[] = [];
	let waiting: (() => void) | null = null;
	/** Sources whose end marker has been consumed, so their batches are all out. */
	let completed = 0;
	const endReasons: string[] = [];

	const push = (item: Item): void => {
		queue.push(item);
		const wake = waiting;
		waiting = null;
		wake?.();
	};

	for (const source of sources) {
		void (async () => {
			let endReason: string | null = null;
			try {
				for await (const batch of source) {
					if (batch.type === 'end') endReason = batch.reason;
					else push({ batch });
				}
			} catch {
				// A source that throws is treated as finished with an unknown reason.
			} finally {
				if (endReason !== null) endReasons.push(endReason);
				// Every batch of this source is queued before its marker, so consuming
				// the marker proves nothing of this source is left behind.
				push({ done: true });
			}
		})();
	}

	for (;;) {
		if (queue.length === 0) {
			if (completed >= sources.length) {
				yield { type: 'end', reason: mergeEndReason(endReasons) };
				return;
			}
			await new Promise<void>((resolve) => {
				waiting = resolve;
				// A push can land between the check above and this registration, so
				// look once more before sleeping: a lost wakeup would hang the stream.
				if (queue.length > 0 || completed >= sources.length) {
					waiting = null;
					resolve();
				}
			});
			continue;
		}
		const item = queue.shift() as Item;
		if ('batch' in item) yield item.batch;
		else completed += 1;
	}
}
