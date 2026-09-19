import { describe, expect, it } from 'vitest';
import { compactGroupName } from './group-name';
const measure = (value: string) => value.length;

describe('compactGroupName', () => {
	it('keeps the full path when it fits', () => {
		expect(compactGroupName('/aws/lambda/payments/checkout', 40, measure)).toBe(
			'/aws/lambda/payments/checkout',
		);
	});
	it('drops whole prefix segments while preserving as many suffixes as fit', () => {
		expect(compactGroupName('/aws/lambda/payments/checkout', 23, measure)).toBe(
			'../payments/checkout',
		);
		expect(compactGroupName('/aws/lambda/payments/checkout', 15, measure)).toBe('../checkout');
	});
	it('keeps the end of a leaf that cannot fit by itself', () => {
		expect(compactGroupName('/aws/lambda/checkout-production', 12, measure)).toBe('..production');
		expect(compactGroupName('checkout-production', 12, measure)).toBe('..production');
	});
	it('handles exact fits, empty names and tiny widths', () => {
		expect(compactGroupName('/a/b', 4, measure)).toBe('/a/b');
		expect(compactGroupName('', 4, measure)).toBe('');
		expect(compactGroupName('/a/b', 1, measure)).toBe('..');
	});
});
