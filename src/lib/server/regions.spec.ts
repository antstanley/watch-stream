import { describe, expect, test } from 'vitest';
import { REGION_CODES } from '$lib/regions';
import { FALLBACK_REGIONS, resolveRegions } from './regions';

describe('FALLBACK_REGIONS', () => {
	test('contains the common regions', () => {
		for (const region of [
			'us-east-1',
			'us-east-2',
			'us-west-1',
			'us-west-2',
			'eu-west-1',
			'eu-central-1',
			'ap-southeast-1',
			'ap-southeast-2',
			'ap-northeast-1',
			'af-south-1',
		]) {
			expect(FALLBACK_REGIONS).toContain(region);
		}
	});

	test('mirrors the shared region list, including af-south-1', () => {
		expect(FALLBACK_REGIONS).toEqual([...REGION_CODES]);
		expect(FALLBACK_REGIONS).toContain('af-south-1');
	});

	test('accepts af-south-1 from WATCH_STREAM_REGIONS', () => {
		const { regions, defaultRegion } = resolveRegions({
			WATCH_STREAM_REGIONS: 'af-south-1,eu-west-1',
			AWS_REGION: 'af-south-1',
		});
		expect(defaultRegion).toBe('af-south-1');
		expect(regions).toEqual(['af-south-1', 'eu-west-1']);
	});
});

describe('resolveRegions', () => {
	test('uses the fallback list when the env var is unset', () => {
		const { regions, defaultRegion } = resolveRegions({});
		expect(regions).toEqual(FALLBACK_REGIONS);
		expect(defaultRegion).toBe('us-east-1');
		// The default region is never duplicated.
		expect(regions.filter((region) => region === defaultRegion)).toHaveLength(1);
	});

	test('parses, trims, de-duplicates and keeps order', () => {
		const { regions } = resolveRegions({
			WATCH_STREAM_REGIONS: ' eu-west-1 , us-east-1,eu-west-1,, ap-south-1 ',
			AWS_REGION: 'us-east-1',
		});
		expect(regions).toEqual(['eu-west-1', 'us-east-1', 'ap-south-1']);
	});

	test('prepends the default region when it is missing', () => {
		const { regions, defaultRegion } = resolveRegions({
			WATCH_STREAM_REGIONS: 'eu-west-1,eu-central-1',
			AWS_REGION: 'ap-south-1',
		});
		expect(defaultRegion).toBe('ap-south-1');
		expect(regions).toEqual(['ap-south-1', 'eu-west-1', 'eu-central-1']);
	});

	test('ignores an empty or blank env var', () => {
		expect(resolveRegions({ WATCH_STREAM_REGIONS: '   ,  ' }).regions).toEqual(FALLBACK_REGIONS);
		expect(resolveRegions({ WATCH_STREAM_REGIONS: '' }).regions).toEqual(FALLBACK_REGIONS);
	});

	test('takes the default region from AWS_DEFAULT_REGION as well', () => {
		const { regions, defaultRegion } = resolveRegions({
			WATCH_STREAM_REGIONS: 'us-west-1',
			AWS_DEFAULT_REGION: 'us-west-2',
		});
		expect(defaultRegion).toBe('us-west-2');
		expect(regions).toEqual(['us-west-2', 'us-west-1']);
	});

	test('falls back to the effective region when the env var is unset', () => {
		const { regions, defaultRegion } = resolveRegions({}, 'us-west-1');
		expect(defaultRegion).toBe('us-west-1');
		expect(regions).toEqual(FALLBACK_REGIONS);
	});

	test('prepends an effective region that is missing from the list', () => {
		// A region outside the standard partition, so it is never in the list.
		const { regions, defaultRegion } = resolveRegions({}, 'us-gov-west-1');
		expect(defaultRegion).toBe('us-gov-west-1');
		expect(regions[0]).toBe('us-gov-west-1');
		expect(regions).toHaveLength(FALLBACK_REGIONS.length + 1);
		expect(regions.filter((region) => region === 'us-gov-west-1')).toHaveLength(1);
	});

	test('prepends the effective region before a configured list', () => {
		const { regions, defaultRegion } = resolveRegions(
			{ WATCH_STREAM_REGIONS: 'eu-west-1,us-east-1' },
			'ap-south-1',
		);
		expect(defaultRegion).toBe('ap-south-1');
		expect(regions).toEqual(['ap-south-1', 'eu-west-1', 'us-east-1']);
	});

	test('lets an explicit env region win over the effective region', () => {
		const { regions, defaultRegion } = resolveRegions({ AWS_REGION: 'eu-west-1' }, 'us-west-1');
		expect(defaultRegion).toBe('eu-west-1');
		expect(regions).toEqual(FALLBACK_REGIONS);
	});

	test('ignores a blank effective region', () => {
		expect(resolveRegions({}, '   ').defaultRegion).toBe('us-east-1');
		expect(resolveRegions({}, null).defaultRegion).toBe('us-east-1');
		expect(resolveRegions({}, undefined).defaultRegion).toBe('us-east-1');
	});

	test('keeps the default region unique when it is already in the list', () => {
		const { regions } = resolveRegions(
			{ WATCH_STREAM_REGIONS: 'us-east-1,eu-west-1' },
			'us-east-1',
		);
		expect(regions).toEqual(['us-east-1', 'eu-west-1']);
	});
});
