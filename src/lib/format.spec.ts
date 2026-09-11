import { describe, expect, it } from 'vitest';
import {
	EMPTY_TIME,
	EMPTY_VALUE,
	describeEndpoint,
	emulatorLabel,
	formatBytes,
	formatCount,
	formatTime,
	formatTimestamp,
} from './format';

describe('formatTime', () => {
	it('renders UTC HH:MM:SS.mmm', () => {
		expect(formatTime(Date.UTC(2024, 0, 2, 3, 4, 5, 678))).toBe('03:04:05.678');
		expect(formatTime(0)).toBe('00:00:00.000');
	});

	it('pads milliseconds to three digits', () => {
		expect(formatTime(Date.UTC(2024, 5, 6, 7, 8, 9, 7))).toBe('07:08:09.007');
	});

	it('falls back to a placeholder for missing values', () => {
		expect(formatTime(undefined)).toBe(EMPTY_TIME);
		expect(formatTime(null)).toBe(EMPTY_TIME);
		expect(formatTime(Number.NaN)).toBe(EMPTY_TIME);
	});
});

describe('formatTimestamp', () => {
	it('renders an ISO 8601 string', () => {
		expect(formatTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
	});

	it('falls back to a placeholder for missing values', () => {
		expect(formatTimestamp(null)).toBe(EMPTY_VALUE);
	});
});

describe('formatBytes', () => {
	it('renders raw bytes below one KiB', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1023)).toBe('1023 B');
	});

	it('scales to KiB, MiB, GiB and TiB', () => {
		expect(formatBytes(1024)).toBe('1 KiB');
		expect(formatBytes(1536)).toBe('1.5 KiB');
		expect(formatBytes(10 * 1024)).toBe('10 KiB');
		expect(formatBytes(1024 * 1024)).toBe('1 MiB');
		expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GiB');
		expect(formatBytes(1024 ** 4)).toBe('1 TiB');
	});

	it('falls back to a placeholder for missing or negative values', () => {
		expect(formatBytes(undefined)).toBe(EMPTY_VALUE);
		expect(formatBytes(Number.NaN)).toBe(EMPTY_VALUE);
		expect(formatBytes(-1)).toBe(EMPTY_VALUE);
	});
});

describe('formatCount', () => {
	it('inserts thousands separators', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(42)).toBe('42');
		expect(formatCount(1234)).toBe('1,234');
		expect(formatCount(1_000_000)).toBe('1,000,000');
		expect(formatCount(-1234)).toBe('-1,234');
	});

	it('falls back to zero for missing values', () => {
		expect(formatCount(undefined)).toBe('0');
		expect(formatCount(Number.NaN)).toBe('0');
	});
});

describe('emulatorLabel', () => {
	it('detects floci by name and by port', () => {
		expect(emulatorLabel('http://floci:4566')).toBe('floci');
		expect(emulatorLabel('http://localhost:4566')).toBe('floci');
		expect(emulatorLabel('http://localhost:4566/')).toBe('floci');
	});

	it('detects localstack', () => {
		expect(emulatorLabel('http://localhost.localstack.cloud:4566')).toBe('localstack');
	});

	it('falls back to a generic label and null for real AWS', () => {
		expect(emulatorLabel('http://127.0.0.1:9999')).toBe('local emulator');
		expect(emulatorLabel(null)).toBeNull();
		expect(emulatorLabel('')).toBeNull();
		expect(emulatorLabel(undefined)).toBeNull();
	});
});

describe('describeEndpoint', () => {
	it('joins the emulator name and the endpoint', () => {
		expect(describeEndpoint('http://localhost:4566')).toBe('floci http://localhost:4566');
	});

	it('does not repeat a hostname that already names the emulator', () => {
		expect(describeEndpoint('http://floci:4566')).toBe('http://floci:4566');
	});

	it('returns null for real AWS', () => {
		expect(describeEndpoint(null)).toBeNull();
		expect(describeEndpoint('')).toBeNull();
	});
});
