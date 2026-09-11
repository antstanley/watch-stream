import { describe, expect, test } from 'vitest';
import { REGION_CODES } from './regions';

describe('REGION_CODES', () => {
	test('covers the CloudWatch Logs regions the picker should offer', () => {
		for (const region of [
			'us-east-1',
			'us-west-2',
			'ca-west-1',
			'mx-central-1',
			'sa-east-1',
			'eu-central-2',
			'eu-south-2',
			'af-south-1',
			'me-central-1',
			'il-central-1',
			'ap-east-1',
			'ap-south-2',
			'ap-southeast-7',
			'ap-northeast-3',
		]) {
			expect(REGION_CODES).toContain(region);
		}
	});

	test('lists each region once and in a valid format', () => {
		expect(new Set(REGION_CODES).size).toBe(REGION_CODES.length);
		for (const region of REGION_CODES) {
			expect(region).toMatch(/^[a-z]{2}(-[a-z]+)+-\d+$/);
		}
	});

	test('starts with us-east-1 and excludes the non-standard partitions', () => {
		expect(REGION_CODES[0]).toBe('us-east-1');
		expect(REGION_CODES.some((region) => region.startsWith('cn-'))).toBe(false);
		expect(REGION_CODES.some((region) => region.startsWith('us-gov-'))).toBe(false);
		expect(REGION_CODES.some((region) => region.startsWith('fips-'))).toBe(false);
	});
});
