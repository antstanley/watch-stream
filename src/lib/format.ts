/**
 * Formatting helpers for the watch-stream UI. Every function here is pure so it can be unit
 * tested without a DOM.
 */

/** Placeholder shown when a timestamp is missing or not a number. */
export const EMPTY_TIME = '--:--:--.---';

/** Placeholder shown when a value is missing. */
export const EMPTY_VALUE = '\u2014';

/** Left-pads a non-negative integer with zeros. */
function pad(value: number, size = 2): string {
	return String(Math.trunc(Math.abs(value))).padStart(size, '0');
}

/**
 * Formats an epoch-millisecond timestamp as `HH:MM:SS.mmm` in UTC.
 * UTC keeps rendering stable no matter where the browser runs.
 */
export function formatTime(timestamp: number | null | undefined): string {
	if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return EMPTY_TIME;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return EMPTY_TIME;
	const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
	return `${clock}.${pad(date.getUTCMilliseconds(), 3)}`;
}

/** Formats an epoch-millisecond timestamp as an ISO 8601 string, for tooltips. */
export function formatTimestamp(timestamp: number | null | undefined): string {
	if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return EMPTY_VALUE;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return EMPTY_VALUE;
	return date.toISOString();
}

/** Formats a number with at most one decimal, dropping a trailing `.0`. */
function trimZero(value: number): string {
	const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
	return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/**
 * Formats a byte count as `B`, `KiB`, `MiB` or `GiB`, with at most one decimal for scaled units.
 * Returns {@link EMPTY_VALUE} for a missing or negative value.
 */
export function formatBytes(bytes: number | null | undefined): string {
	if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return EMPTY_VALUE;
	if (bytes < 1024) return `${Math.trunc(bytes)} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes / 1024;
	let unit = units[0];
	for (let index = 1; index < units.length && value >= 1024; index += 1) {
		value /= 1024;
		unit = units[index];
	}
	return `${trimZero(value)} ${unit}`;
}

/** Formats an integer count with thousands separators, for example `1,234`. */
export function formatCount(value: number | null | undefined): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
	const rounded = Math.trunc(value);
	const sign = rounded < 0 ? '-' : '';
	return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Names the emulator behind a CloudWatch Logs endpoint override.
 * Returns `null` when the endpoint is empty, which means real AWS.
 */
export function emulatorLabel(endpoint: string | null | undefined): string | null {
	const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
	if (trimmed === '') return null;
	const lower = trimmed.toLowerCase();
	if (lower.includes('floci')) return 'floci';
	if (lower.includes('localstack')) return 'localstack';
	// floci serves every service on its default port 4566.
	if (endpointPort(trimmed) === '4566') return 'floci';
	return 'local emulator';
}

/** Reads the port of an endpoint URL, or `null` when it cannot be parsed. */
function endpointPort(endpoint: string): string | null {
	return parseEndpoint(endpoint)?.port || null;
}

/** Parses an endpoint URL, returning `null` when it is not a URL. */
function parseEndpoint(endpoint: string): URL | null {
	try {
		return new URL(endpoint);
	} catch {
		return null;
	}
}

/**
 * Builds the header badge text for an endpoint, for example `floci http://localhost:4566`.
 * Returns `null` when the app talks to real AWS.
 */
export function describeEndpoint(endpoint: string | null | undefined): string | null {
	const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
	if (trimmed === '') return null;
	const label = emulatorLabel(trimmed);
	if (label === null) return null;
	// A hostname that already names the emulator would otherwise read as `floci http://floci:4566`.
	const host = parseEndpoint(trimmed)?.hostname.toLowerCase() ?? trimmed.toLowerCase();
	return host.startsWith(label) ? trimmed : `${label} ${trimmed}`;
}
