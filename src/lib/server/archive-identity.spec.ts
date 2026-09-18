import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { STSClient } from '@aws-sdk/client-sts';
import { expect, test, vi } from 'vitest';
import { createStsClient, resolveAwsConfig } from './aws';
import { ArchiveLocator } from './archive-location';
import { getCallerIdentityWith } from './identity';

vi.mock('./identity', () => ({
	getCallerIdentityWith: vi.fn<typeof getCallerIdentityWith>(async () => ({
		account: '111111111111',
		arn: '',
		userId: '',
	})),
}));

test.each([
	{ env: { AWS_ENDPOINT_URL_LOGS: 'https://logs.example.test' }, endpoint: null },
	{
		env: {
			AWS_ENDPOINT_URL_LOGS: 'https://logs.example.test',
			AWS_ENDPOINT_URL_STS: 'https://sts.example.test',
			AWS_ENDPOINT_URL: 'http://localhost:4566',
		},
		endpoint: 'sts.example.test',
	},
	{
		env: { AWS_ENDPOINT_URL: 'http://localhost:4566' },
		endpoint: 'localhost',
	},
	{
		env: { AWS_ENDPOINT_URL_STS: '  ', AWS_ENDPOINT_URL: 'http://localhost:4566' },
		endpoint: 'localhost',
	},
])('archive identity uses the STS endpoint: $endpoint', async ({ env, endpoint }) => {
	const root = mkdtempSync(join(tmpdir(), 'watch-tail-identity-'));
	try {
		const path = await new ArchiveLocator().locate(
			join(root, 'archive.duckdb'),
			{ ...env, AWS_REGION: 'eu-west-1' },
			{},
		);
		const client = vi.mocked(getCallerIdentityWith).mock.lastCall![0] as STSClient;
		expect(client.config.endpoint ? (await client.config.endpoint()).hostname : null).toBe(
			endpoint,
		);
		expect(path).toContain(join('111111111111', 'eu-west-1', 'archive.duckdb'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each(['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_STS'])(
	'preserves emulator credentials for %s',
	async (key) => {
		const client = createStsClient(
			resolveAwsConfig({ [key]: 'http://localhost:4566' }, 'eu-west-1', 'sts'),
		);
		try {
			expect(await client.config.credentials()).toMatchObject({
				accessKeyId: 'test',
				secretAccessKey: 'test',
			});
		} finally {
			client.destroy();
		}
	},
);
