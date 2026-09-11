import { describe, expect, test } from 'vitest';
import type { WindowResult } from './filter';
import {
	HISTORIC_PRESETS,
	clampPollMs,
	isHistoricPreset,
	parseDurationMs,
	parseInstant,
	parseMode,
	parseStartTime,
	presetDurationMs,
	resolveStartTime,
	resolveWindow,
} from './filter';

const NOW = Date.UTC(2024, 4, 17, 12, 0, 0);
const MINUTE = 60_000;

describe('parseDurationMs', () => {
	test.each([
		['500ms', 500],
		['30s', 30_000],
		['15m', 15 * MINUTE],
		['2h', 2 * 60 * MINUTE],
		['3d', 3 * 24 * 60 * MINUTE],
		['1w', 7 * 24 * 60 * MINUTE],
		[' 15m ', 15 * MINUTE],
		['15M', 15 * MINUTE],
		['1.5h', 90 * MINUTE],
	])('parses %s', (value, expected) => {
		expect(parseDurationMs(value)).toBe(expected);
	});

	test.each([
		[''],
		['abc'],
		['15'],
		['m'],
		['ms'],
		['-15m'],
		['0s'],
		['0ms'],
		['15 minutes'],
		['1h30m'],
	])('rejects %s', (value) => {
		expect(parseDurationMs(value)).toBeNull();
	});

	test('rejects non-string input', () => {
		expect(parseDurationMs(null as unknown as string)).toBeNull();
		expect(parseDurationMs(undefined as unknown as string)).toBeNull();
	});
});

describe('parseStartTime', () => {
	test('parses epoch milliseconds', () => {
		expect(parseStartTime('1700000000000', NOW)).toBe(1_700_000_000_000);
		expect(parseStartTime(' 1700000000000 ', NOW)).toBe(1_700_000_000_000);
	});

	test('parses durations relative to now', () => {
		expect(parseStartTime('15m', NOW)).toBe(NOW - 15 * MINUTE);
		expect(parseStartTime('2h', NOW)).toBe(NOW - 120 * MINUTE);
	});

	test('parses ISO 8601 timestamps', () => {
		expect(parseStartTime('2024-05-17T11:45:00.000Z', NOW)).toBe(NOW - 15 * MINUTE);
		expect(parseStartTime('2024-05-17', NOW)).toBe(Date.parse('2024-05-17'));
	});

	test('returns null for missing or invalid values', () => {
		expect(parseStartTime(null, NOW)).toBeNull();
		expect(parseStartTime(undefined, NOW)).toBeNull();
		expect(parseStartTime('   ', NOW)).toBeNull();
		expect(parseStartTime('yesterday-ish', NOW)).toBeNull();
		expect(parseStartTime('-5m', NOW)).toBeNull();
	});
});

describe('resolveStartTime', () => {
	test('prefers an explicit start time', () => {
		expect(resolveStartTime({ startTime: '30m', lookback: '2h', now: NOW })).toBe(
			NOW - 30 * MINUTE,
		);
		expect(resolveStartTime({ startTime: String(NOW - 1000), lookback: '2h', now: NOW })).toBe(
			NOW - 1000,
		);
	});

	test('uses the lookback when startTime is absent or invalid', () => {
		expect(resolveStartTime({ lookback: '2h', now: NOW })).toBe(NOW - 120 * MINUTE);
		expect(resolveStartTime({ startTime: 'nonsense', lookback: '90s', now: NOW })).toBe(
			NOW - 90_000,
		);
	});

	test('defaults to a five minute lookback', () => {
		expect(resolveStartTime({ now: NOW })).toBe(NOW - 5 * MINUTE);
		expect(resolveStartTime({ startTime: null, lookback: null, now: NOW })).toBe(NOW - 5 * MINUTE);
		expect(resolveStartTime({ lookback: 'abc', now: NOW })).toBe(NOW - 5 * MINUTE);
		expect(resolveStartTime({ lookback: '0s', now: NOW })).toBe(NOW - 5 * MINUTE);
	});

	test('never returns a future start time', () => {
		expect(resolveStartTime({ startTime: String(NOW + 600_000), now: NOW })).toBe(NOW);
	});

	test('clamps start times older than 14 days', () => {
		const fourteenDays = 14 * 24 * 60 * MINUTE;
		expect(resolveStartTime({ startTime: '30d', now: NOW })).toBe(NOW - fourteenDays);
		expect(resolveStartTime({ startTime: '0', now: NOW })).toBe(NOW - fourteenDays);
	});
});

describe('clampPollMs', () => {
	test('returns the parsed value inside the range', () => {
		expect(clampPollMs('4000')).toBe(4000);
		expect(clampPollMs(' 750 ')).toBe(750);
	});

	test('clamps to 250..15000', () => {
		expect(clampPollMs('10')).toBe(250);
		expect(clampPollMs('0')).toBe(250);
		expect(clampPollMs('-100')).toBe(250);
		expect(clampPollMs('999999')).toBe(15_000);
	});

	test('defaults to 1000 for missing or non-numeric values', () => {
		expect(clampPollMs(null)).toBe(1000);
		expect(clampPollMs(undefined)).toBe(1000);
		expect(clampPollMs('')).toBe(1000);
		expect(clampPollMs('   ')).toBe(1000);
		expect(clampPollMs('fast')).toBe(1000);
		expect(clampPollMs('1e999')).toBe(1000);
	});
});

describe('parseMode and presets', () => {
	test('parses live and historic, tolerating case and blanks', () => {
		expect(parseMode('live')).toBe('live');
		expect(parseMode(' HISTORIC ')).toBe('historic');
		expect(parseMode('')).toBeNull();
		expect(parseMode('window')).toBeNull();
	});

	test('offers the documented presets and durations', () => {
		expect([...HISTORIC_PRESETS]).toEqual(['15m', '1h', '3h', '12h', '24h', '5d']);
		expect(presetDurationMs('15m')).toBe(15 * 60 * 1000);
		expect(presetDurationMs('1h')).toBe(60 * 60 * 1000);
		expect(presetDurationMs('3h')).toBe(3 * 60 * 60 * 1000);
		expect(presetDurationMs('12h')).toBe(12 * 60 * 60 * 1000);
		expect(presetDurationMs('24h')).toBe(24 * 60 * 60 * 1000);
		expect(presetDurationMs('5d')).toBe(5 * 24 * 60 * 60 * 1000);
		expect(isHistoricPreset('5days')).toBe(false);
	});
});

describe('parseInstant', () => {
	test('accepts epoch milliseconds and ISO 8601 only', () => {
		expect(parseInstant('1700000000000')).toBe(1_700_000_000_000);
		expect(parseInstant('2023-11-14T22:13:20.000Z')).toBe(1_700_000_000_000);
		expect(parseInstant('3h')).toBeNull();
		expect(parseInstant('yesterday')).toBeNull();
		expect(parseInstant('')).toBeNull();
		expect(parseInstant(null)).toBeNull();
	});
});

/** Narrows a window result to the success case, failing the test otherwise. */
function unwrapWindow(result: WindowResult): Extract<WindowResult, { ok: true }> {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`unexpected window failure: ${result.code}`);
	return result;
}

describe('resolveWindow', () => {
	const now = Date.UTC(2024, 4, 10, 12, 0, 0);

	test('defaults to live mode with the usual lookback', () => {
		const result = unwrapWindow(resolveWindow({ now }));
		expect(result).toMatchObject({ mode: 'live', endTime: null, preset: null });
		expect(result.startTime).toBe(now - 5 * 60 * 1000);
	});

	test('keeps live startTime and lookback behaviour', () => {
		expect(unwrapWindow(resolveWindow({ mode: 'live', startTime: '2h', now })).startTime).toBe(
			now - 2 * 60 * 60 * 1000,
		);
		expect(resolveWindow({ mode: 'live', lookback: '30m', now })).toMatchObject({
			ok: true,
			mode: 'live',
		});
	});

	test('builds a preset window ending now', () => {
		for (const preset of HISTORIC_PRESETS) {
			const result = unwrapWindow(resolveWindow({ mode: 'historic', range: preset, now }));
			expect(result.mode).toBe('historic');
			expect(result.preset).toBe(preset);
			expect(result.endTime).toBe(now);
			expect(result.startTime).toBe(now - presetDurationMs(preset));
		}
	});

	test('uses the smallest preset when historic mode names no range', () => {
		const result = resolveWindow({ mode: 'historic', now });
		expect(result).toMatchObject({ ok: true, mode: 'historic', preset: '15m', endTime: now });
	});

	test('accepts a custom from/to window', () => {
		const from = now - 90 * 60 * 1000;
		const result = resolveWindow({
			mode: 'historic',
			from: String(from),
			to: '2024-05-10T11:30:00.000Z',
			now,
		});
		const unwrapped = unwrapWindow(result);
		expect(unwrapped).toMatchObject({ mode: 'historic', preset: null, startTime: from });
		expect(unwrapped.endTime).toBe(Date.UTC(2024, 4, 10, 11, 30, 0));
	});

	test('clamps a custom window to the last 14 days and to now', () => {
		const tooOld = now - 30 * 24 * 60 * 60 * 1000;
		const result = resolveWindow({
			mode: 'historic',
			from: String(tooOld),
			to: String(now + 60 * 60 * 1000),
			now,
		});
		const unwrapped = unwrapWindow(result);
		expect(unwrapped.clamped).toBe(true);
		expect(unwrapped.startTime).toBe(now - 14 * 24 * 60 * 60 * 1000);
		expect(unwrapped.endTime).toBe(now);
	});

	test('rejects bad modes, ranges, times and inverted windows', () => {
		expect(resolveWindow({ mode: 'window', now })).toMatchObject({
			ok: false,
			code: 'invalid-mode',
		});
		expect(resolveWindow({ mode: 'historic', range: '5days', now })).toMatchObject({
			ok: false,
			code: 'invalid-range',
		});
		expect(resolveWindow({ mode: 'historic', from: 'nope', to: 'also-nope', now })).toMatchObject({
			ok: false,
			code: 'invalid-time',
		});
		expect(resolveWindow({ mode: 'historic', from: '1h', now })).toMatchObject({
			ok: false,
			code: 'invalid-window',
		});
		expect(
			resolveWindow({ mode: 'historic', from: String(now), to: String(now - 60_000), now }),
		).toMatchObject({ ok: false, code: 'invalid-window' });
		// A window entirely older than the retention limit cannot be served.
		expect(
			resolveWindow({
				mode: 'historic',
				from: String(now - 40 * 24 * 60 * 60 * 1000),
				to: String(now - 30 * 24 * 60 * 60 * 1000),
				now,
			}),
		).toMatchObject({ ok: false, code: 'invalid-window' });
	});

	test('treats relabelled custom bounds as live-mode inputs only', () => {
		// `to` never accepts a relative duration, so the window cannot drift.
		expect(resolveWindow({ mode: 'historic', from: '1h', to: '30m', now })).toMatchObject({
			ok: false,
			code: 'invalid-time',
		});
	});
});
