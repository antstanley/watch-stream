import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ArchiveLocator } from './archive-location';

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), 'watch-tail-scope-'));
	roots.push(value);
	return value;
}
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('account and region archive selection', () => {
	test('separates accounts and regions, while profiles of the same account share a file', async () => {
		const base = join(root(), 'archive.duckdb');
		const locator = new ArchiveLocator(async (env, region) => ({
			account: env.AWS_PROFILE === 'other' ? '222222222222' : '111111111111',
			region: region ?? 'eu-west-1',
		}));
		const first = await locator.locate(base, { AWS_PROFILE: 'first' }, { region: 'eu-west-1' });
		expect(first).toBe(join(base, '..', '111111111111', 'eu-west-1', 'archive.duckdb'));
		expect(await locator.locate(base, { AWS_PROFILE: 'alias' }, { region: 'eu-west-1' })).toBe(
			first,
		);
		expect(await locator.locate(base, { AWS_PROFILE: 'other' }, { region: 'eu-west-1' })).not.toBe(
			first,
		);
		expect(await locator.locate(base, { AWS_PROFILE: 'first' }, { region: 'us-east-1' })).not.toBe(
			first,
		);
	});

	test('offline reads reuse a verified mapping across restarts; writes never trust it', async () => {
		const base = join(root(), 'archive.duckdb');
		const env = { AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1' };
		const online = new ArchiveLocator(async () => ({
			account: '111111111111',
			region: 'eu-west-1',
		}));
		const path = await online.locate(base, env, {});
		const lookup = vi.fn<() => Promise<{ account: string; region: string }>>(async () => {
			throw new Error('expired SSO');
		});
		const offline = new ArchiveLocator(lookup);
		expect(await offline.locate(base, env, { readOnly: true })).toBe(path);
		expect(lookup).not.toHaveBeenCalled();
		await expect(offline.locate(base, env, {})).rejects.toThrow('expired SSO');
		await expect(
			offline.locate(base, { ...env, AWS_PROFILE: 'unknown' }, { readOnly: true }),
		).rejects.toThrow('expired SSO');
	});

	test('re-verifies writes and updates reads if a profile changes account', async () => {
		const base = join(root(), 'archive.duckdb');
		let account = '111111111111';
		const locator = new ArchiveLocator(async () => ({ account, region: 'eu-west-1' }));
		const first = await locator.locate(base, {}, {});
		account = '222222222222';
		const second = await locator.locate(base, {}, {});
		expect(second).not.toBe(first);
		expect(await locator.locate(base, {}, { readOnly: true })).toBe(second);
	});

	test('isolates custom endpoints from AWS and from each other', async () => {
		const base = join(root(), 'archive.duckdb');
		const locator = new ArchiveLocator(async () => ({
			account: '000000000000',
			region: 'eu-west-1',
		}));
		const paths = await Promise.all(
			[undefined, 'http://localhost:4566', 'http://localhost:4567'].map((AWS_ENDPOINT_URL) =>
				locator.locate(base, { AWS_ENDPOINT_URL }, {}),
			),
		);
		expect(new Set(paths).size).toBe(3);
	});

	test('coalesces simultaneous identity calls and retries after failure', async () => {
		const base = join(root(), 'archive.duckdb');
		const lookup = vi.fn<() => Promise<{ account: string; region: string }>>(async () => ({
			account: '111111111111',
			region: 'eu-west-1',
		}));
		lookup.mockRejectedValueOnce(new Error('temporary failure'));
		const locator = new ArchiveLocator(lookup);
		await expect(locator.locate(base, {}, {})).rejects.toThrow('temporary failure');
		const paths = await Promise.all([locator.locate(base, {}, {}), locator.locate(base, {}, {})]);
		expect(paths[0]).toBe(paths[1]);
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	test.each([
		{ account: '../escape', region: 'eu-west-1' },
		{ account: '', region: 'eu-west-1' },
		{ account: '111111111111', region: '../../escape' },
		{ account: '111111111111', region: '' },
	])('rejects invalid identity/path components: %j', async (identity) => {
		const locator = new ArchiveLocator(async () => identity);
		await expect(locator.locate(join(root(), 'archive.duckdb'), {}, {})).rejects.toThrow(
			'valid archive account and region',
		);
	});

	test('leaves a legacy file untouched and stores only account/region metadata', async () => {
		const directory = root();
		const base = join(directory, 'archive.duckdb');
		writeFileSync(base, 'legacy');
		const locator = new ArchiveLocator(async () => ({
			account: '111111111111',
			region: 'eu-west-1',
		}));
		await locator.locate(
			base,
			{ AWS_ACCESS_KEY_ID: 'example-key', AWS_SECRET_ACCESS_KEY: 'example-secret' },
			{},
		);
		expect(readFileSync(base, 'utf8')).toBe('legacy');
		const files = readdirSync(join(directory, 'identities'));
		expect(files).toHaveLength(1);
		expect(readFileSync(join(directory, 'identities', files[0]), 'utf8')).toBe(
			JSON.stringify({ account: '111111111111', region: 'eu-west-1' }),
		);
	});
});
