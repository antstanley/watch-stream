import { describe, expect, test } from 'vitest';
import { DEFAULT_SOURCE, SOURCE_PARAM_HINT, parseSourceParam } from './source';

describe('parseSourceParam', () => {
	test('defaults to cloudwatch when absent or blank', () => {
		expect(parseSourceParam(null)).toBe('cloudwatch');
		expect(parseSourceParam(undefined)).toBe('cloudwatch');
		expect(parseSourceParam('  ')).toBe('cloudwatch');
		expect(DEFAULT_SOURCE).toBe('cloudwatch');
	});

	test.each(['cloudwatch', 'CLOUDWATCH', ' cloudwatch ', 'archive', 'Archive'])(
		'accepts %s',
		(value) => {
			expect(parseSourceParam(value)).not.toBeNull();
		},
	);

	test('is case and whitespace insensitive', () => {
		expect(parseSourceParam(' ARCHIVE ')).toBe('archive');
	});

	test.each(['aws', 'local', 'history', 'duckdb', '1'])('rejects %s', (value) => {
		expect(parseSourceParam(value)).toBeNull();
		expect(SOURCE_PARAM_HINT).toContain('cloudwatch');
	});
});
