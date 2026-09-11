import {
	HISTORIC_PRESETS,
	isHistoricPreset,
	presetDurationMs,
	type HistoricPreset,
	type LogMode,
} from '$lib/time-range';
/** Default lookback window when neither `startTime` nor `lookback` is usable. */
const DEFAULT_LOOKBACK_MS = 5 * 60 * 1000;
/** CloudWatch Logs rejects `startTime` older than 14 days. */
const MAX_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 15_000;

const DURATION_UNITS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;
const EPOCH_PATTERN = /^\d+$/;

/**
 * Parses a single-unit duration such as `500ms`, `30s`, `15m`, `2h`, `3d` or
 * `1w`. Returns `null` for anything invalid, negative or zero.
 */
export function parseDurationMs(value: string): number | null {
	if (typeof value !== 'string') return null;
	const match = DURATION_PATTERN.exec(value.trim());
	if (match === null) return null;
	const amount = Number(match[1]);
	const unit = DURATION_UNITS[match[2].toLowerCase()];
	if (unit === undefined || !Number.isFinite(amount)) return null;
	const ms = amount * unit;
	if (!Number.isFinite(ms) || ms <= 0) return null;
	return Math.round(ms);
}

/**
 * Parses a start point into epoch milliseconds.
 *
 * Accepts epoch milliseconds (`1700000000000`), a duration relative to `now`
 * (`15m`) and ISO 8601 timestamps. Returns `null` when the value is missing or
 * cannot be understood.
 */
export function parseStartTime(value: string | null | undefined, now: number): number | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (EPOCH_PATTERN.test(trimmed)) return Number(trimmed);
	const duration = parseDurationMs(trimmed);
	if (duration !== null) return now - duration;
	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? null : parsed;
}

/** Resolves the effective start time, clamped to the last 14 days and to `now`. */
export function resolveStartTime(input: {
	startTime?: string | null;
	lookback?: string | null;
	now: number;
}): number {
	const { now } = input;
	const explicit = parseStartTime(input.startTime, now);
	let start = explicit;
	if (start === null) {
		const lookbackMs = parseDurationMs(input.lookback ?? '') ?? DEFAULT_LOOKBACK_MS;
		start = now - lookbackMs;
	}
	const oldestAllowed = now - MAX_LOOKBACK_MS;
	if (start > now) start = now;
	if (start < oldestAllowed) start = oldestAllowed;
	return Math.round(start);
}

/** Parses a poll interval in milliseconds, defaulting to 1000 and clamped to 250..15000. */
export function clampPollMs(value: string | null | undefined): number {
	if (typeof value !== 'string') return DEFAULT_POLL_MS;
	const trimmed = value.trim();
	if (trimmed.length === 0) return DEFAULT_POLL_MS;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) return DEFAULT_POLL_MS;
	return Math.min(Math.max(Math.round(parsed), MIN_POLL_MS), MAX_POLL_MS);
}

export { HISTORIC_PRESETS, isHistoricPreset, presetDurationMs } from '$lib/time-range';

export type WindowRequest = {
	/** `live` (default) or `historic`. */
	mode?: string | null;
	/** Preset name for historic mode, for example `24h`. */
	range?: string | null;
	/** Custom window bounds: epoch ms, ISO 8601 (`from` also accepts a duration). */
	from?: string | null;
	to?: string | null;
	/** Live-mode start point. */
	startTime?: string | null;
	lookback?: string | null;
	now: number;
};

export type WindowResult =
	| {
			ok: true;
			mode: LogMode;
			/** Inclusive start of the window, epoch ms. */
			startTime: number;
			/** Inclusive end of the window for historic mode, `null` when live. */
			endTime: number | null;
			/** Preset that produced the window, or `null` for custom/live windows. */
			preset: HistoricPreset | null;
			/** True when the request was clamped to the 14-day or `now` limits. */
			clamped: boolean;
	  }
	| { ok: false; code: string; message: string };

/** Default historic window when neither `range` nor `from`/`to` is given. */
const DEFAULT_HISTORIC_PRESET: HistoricPreset = '15m';

/** Parses the `mode` parameter; `null` for an unrecognised value. */
export function parseMode(value: string | null | undefined): LogMode | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === 'live' || trimmed === 'historic') return trimmed;
	return null;
}

/**
 * Parses an absolute instant: epoch milliseconds or an ISO 8601 timestamp.
 *
 * Relative durations are deliberately rejected here so an end bound can never
 * move with the clock.
 */
export function parseInstant(value: string | null | undefined): number | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (EPOCH_PATTERN.test(trimmed)) return Number(trimmed);
	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Clamps a window to what CloudWatch Logs can return: 14 days back, ending now.
 *
 * Returns `null` when the requested window ends before the retention floor, so
 * a request for month-old data fails loudly instead of returning a stub window.
 */
function clampWindow(
	start: number,
	end: number,
	now: number,
): { start: number; end: number; clamped: boolean } | null {
	const oldest = now - MAX_LOOKBACK_MS;
	if (end <= oldest) return null;
	const clampedStart = Math.min(Math.max(start, oldest), now);
	const clampedEnd = Math.min(Math.max(end, clampedStart + 1), now);
	return {
		start: Math.round(clampedStart),
		end: Math.round(clampedEnd),
		clamped: clampedStart !== Math.round(start) || clampedEnd !== Math.round(end),
	};
}

/**
 * Resolves the request window into a start time plus, for historic mode, an end
 * time.
 *
 * Historic windows come from a preset (`range=24h`), from explicit bounds
 * (`from`/`to`, epoch ms or ISO 8601) or, when neither is given, from the
 * smallest preset. Windows are clamped to the last 14 days and to `now` so the
 * request can never ask CloudWatch for data it will not return.
 */
export function resolveWindow(input: WindowRequest): WindowResult {
	const { now } = input;
	const requestedMode =
		input.mode === null || input.mode === undefined ? 'live' : input.mode.trim();
	const mode = requestedMode === '' ? 'live' : parseMode(requestedMode);
	if (mode === null) {
		return {
			ok: false,
			code: 'invalid-mode',
			message: 'Invalid mode: expected "live" or "historic"',
		};
	}

	if (mode === 'live') {
		return {
			ok: true,
			mode,
			startTime: resolveStartTime({ startTime: input.startTime, lookback: input.lookback, now }),
			endTime: null,
			preset: null,
			clamped: false,
		};
	}

	const from = input.from?.trim() ?? '';
	const to = input.to?.trim() ?? '';
	if (from.length > 0 || to.length > 0) {
		if (from.length === 0 || to.length === 0) {
			return {
				ok: false,
				code: 'invalid-window',
				message: 'A custom window needs both "from" and "to"',
			};
		}
		const parsedFrom = parseStartTime(from, now);
		const parsedTo = parseInstant(to);
		if (parsedFrom === null) {
			return {
				ok: false,
				code: 'invalid-time',
				message: `Invalid "from": expected epoch milliseconds, a duration such as 3h, or an ISO 8601 timestamp`,
			};
		}
		if (parsedTo === null) {
			return {
				ok: false,
				code: 'invalid-time',
				message: 'Invalid "to": expected epoch milliseconds or an ISO 8601 timestamp',
			};
		}
		if (parsedTo <= parsedFrom) {
			return {
				ok: false,
				code: 'invalid-window',
				message: 'The end of the window must be after its start',
			};
		}
		const clamped = clampWindow(parsedFrom, parsedTo, now);
		if (clamped === null || clamped.end <= clamped.start) {
			return {
				ok: false,
				code: 'invalid-window',
				message: 'The requested window is outside the 14 days CloudWatch Logs keeps',
			};
		}
		return {
			ok: true,
			mode,
			startTime: clamped.start,
			endTime: clamped.end,
			preset: null,
			clamped: clamped.clamped,
		};
	}

	const requestedRange = input.range?.trim() ?? '';
	const preset =
		requestedRange === ''
			? DEFAULT_HISTORIC_PRESET
			: isHistoricPreset(requestedRange)
				? requestedRange
				: null;
	if (preset === null) {
		return {
			ok: false,
			code: 'invalid-range',
			message: `Invalid range: expected one of ${HISTORIC_PRESETS.join(', ')} or an explicit from/to window`,
		};
	}
	const end = Math.round(now);
	const start = Math.round(now - presetDurationMs(preset));
	return { ok: true, mode, startTime: start, endTime: end, preset, clamped: false };
}
