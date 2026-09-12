/**
 * Level handling for the stream route.
 *
 * SvelteKit only allows HTTP method exports from a `+server.ts`, so the helpers
 * live here: parsing the `level` parameter, and tagging live events with the
 * level the archive will store.
 */
import { detectLevel, isLogLevel, type LogLevel } from '$lib/log-buffer';
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
 * Adds the detected level to events that do not carry one.
 *
 * A live CloudWatch event has no level, so the server detects it here and the UI
 * and the archive agree. An event read back from the archive already carries the
 * level that was stored - including `null` for "no signal" - and that value is
 * kept, because re-guessing it would contradict the database.
 */
export function withLevels(events: readonly LogEventDto[]): LogEventDto[] {
	return events.map((event) =>
		event.level === undefined ? { ...event, level: detectLevel(event.message) } : event,
	);
}
