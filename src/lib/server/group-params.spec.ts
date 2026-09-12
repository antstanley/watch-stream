import { describe, expect, test } from 'vitest';
import {
	GROUP_PARAM_HINT,
	MAX_GROUPS,
	TOO_MANY_GROUPS_HINT,
	parseGroupParams,
} from './group-params';

/** Parses and fails loudly when the selection should have been accepted. */
function namesOf(group: string | null, groups: string | null = null): string[] {
	const parsed = parseGroupParams(group, groups);
	if (!parsed.ok) throw new Error(`expected a valid selection, got ${parsed.code}`);
	return parsed.names;
}

describe('parseGroupParams', () => {
	test('accepts the single group parameter on its own', () => {
		expect(namesOf('/aws/lambda/api')).toEqual(['/aws/lambda/api']);
	});

	test('accepts a comma-separated list', () => {
		expect(namesOf(null, '/aws/lambda/api,/app/worker')).toEqual([
			'/aws/lambda/api',
			'/app/worker',
		]);
	});

	test('merges both parameters, keeping the request order and dropping duplicates', () => {
		expect(namesOf('/first', '/second,/first, /third ')).toEqual(['/first', '/second', '/third']);
	});

	test('trims blanks and ignores empty entries', () => {
		expect(namesOf('  ', ' /a , ,  /b ,')).toEqual(['/a', '/b']);
	});

	test('keeps group names that contain spaces or commas are not supported', () => {
		expect(namesOf('/aws/lambda/my api')).toEqual(['/aws/lambda/my api']);
		expect(namesOf('/a, /b')).toEqual(['/a', '/b']);
	});

	test('rejects a request with no group at all', () => {
		expect(parseGroupParams(null, null)).toEqual({
			ok: false,
			code: 'missing-group',
			message: GROUP_PARAM_HINT,
		});
		expect(parseGroupParams('   ', ' , ')).toMatchObject({ ok: false, code: 'missing-group' });
	});

	test('accepts the maximum and rejects one more', () => {
		const allowed = Array.from({ length: MAX_GROUPS }, (_, index) => `/g${index}`);
		expect(namesOf(null, allowed.join(','))).toHaveLength(MAX_GROUPS);
		const tooMany = [...allowed, '/g-extra'];
		expect(parseGroupParams(null, tooMany.join(','))).toEqual({
			ok: false,
			code: 'too-many-groups',
			message: TOO_MANY_GROUPS_HINT,
		});
	});

	test('counts duplicates once, so a repeated list is not "too many"', () => {
		const repeated = Array.from({ length: MAX_GROUPS * 2 }, () => '/same').join(',');
		expect(namesOf(null, repeated)).toEqual(['/same']);
	});
});
