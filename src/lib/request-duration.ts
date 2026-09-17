import { findJsonInMessage } from './log-format';

/** Explicit event duration in milliseconds; malformed or negative values are ignored. */
export function eventDurationMs(message: string): number {
	const payload = findJsonInMessage(message);
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 0;
	const record = payload as Record<string, unknown>;
	for (const key of ['duration', 'durationMs']) {
		const value = record[key];
		if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) continue;
		const duration = Number(value);
		if (Number.isFinite(duration) && duration >= 0 && duration <= Number.MAX_SAFE_INTEGER)
			return duration;
	}
	return 0;
}
