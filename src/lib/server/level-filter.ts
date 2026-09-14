/**
 * Detection for the stream route: the `level` parameter, and the fields the
 * archive stores.
 *
 * SvelteKit only allows HTTP method exports from a `+server.ts`, so the helpers
 * live here: parsing the `level` parameter, and tagging outgoing events with the
 * level and the request id that the archive will store for them.
 */
import { detectLevel, detectRequestId, isLogLevel, type LogLevel } from '$lib/log-buffer';
import type { LogEventDto } from '$lib/types';

/** Message used when `level` cannot be understood, or when it is misapplied. */
export const LEVEL_PARAM_HINT =
	'Invalid level: expected one or more of error, warn, info, debug (comma separated)';

/**
 * Parses the `level` parameter into the levels to include.
 *
 * Returns `null` when the parameter is absent or blank (every level) and
 * `undefined` when it names something that is not a level, so the caller can
 * answer 400 instead of silently ignoring a filter the user asked for.
 */
export function parseLevelParam(value: string | null | undefined): LogLevel[] | null | undefined {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	const levels: LogLevel[] = [];
	for (const part of trimmed.split(',')) {
		const word = part.trim().toLowerCase();
		if (word.length === 0) continue;
		if (!isLogLevel(word)) return undefined;
		if (!levels.includes(word)) levels.push(word);
	}
	return levels.length === 0 ? null : levels;
}

/**
 * Fills in the fields the archive stores for an event: its level and its request
 * id.
 *
 * This is where a live CloudWatch event gets what the archive will hold, so the
 * UI, the chart and the database all describe the same line the same way. It runs
 * for every batch, whatever the source, because the two fields are decided one
 * by one:
 *
 * - `level` is only detected when the event does not already carry one. A row
 *   replayed from the archive has the level that was stored, including an
 *   explicit `null` for "no signal", and re-guessing it would contradict the
 *   database.
 * - `requestId` is only detected when it is absent. An explicit `null` from the
 *   archive stays `null`, since that is what the row says; a row written before
 *   the column existed has no property at all and is detected here.
 */
export function withDetections(events: readonly LogEventDto[]): LogEventDto[] {
	return events.map((event) => {
		const level = event.level === undefined ? detectLevel(event.message) : event.level;
		const requestId =
			event.requestId === undefined ? detectRequestId(event.message) : event.requestId;
		if (level === event.level && requestId === event.requestId) return event;
		return { ...event, level, requestId };
	});
}
