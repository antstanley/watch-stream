import { describe, expect, test } from 'vitest';
import { readEnv } from './env';

/** `@types/node` is not installed here, so `process` is reached through `globalThis`. */
const nodeEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
	.process.env;

describe('readEnv', () => {
	test('exposes process.env values', () => {
		nodeEnv.WATCH_TAIL_ENV_PROBE = 'probe-value';
		expect(readEnv().WATCH_TAIL_ENV_PROBE).toBe('probe-value');
	});

	test('returns a plain record of the ambient environment', () => {
		const env = readEnv();
		expect(typeof env).toBe('object');
		expect(Object.keys(env).length).toBeGreaterThan(0);
		expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
	});
});
