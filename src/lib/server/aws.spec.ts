import { describe, expect, test, vi } from 'vitest';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import {
	type AwsConfig,
	EMULATOR_CREDENTIALS,
	FALLBACK_REGION,
	createLogsClient,
	describeAwsError,
	parseRegionParam,
	resolveAwsConfig,
	resolveEffectiveRegion,
} from './aws';

/** `@types/node` is not installed here, so `process` is reached through `globalThis`. */
const nodeEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
	.process.env;

const MISSING_REGION_MESSAGE =
	'No AWS region is configured. Set AWS_REGION or add a region to your AWS profile.';

/** Builds a client stub whose region provider is scripted. */
function fakeClient(region: () => Promise<unknown>): CloudWatchLogsClient {
	return { config: { region } } as unknown as CloudWatchLogsClient;
}

/** A region provider that resolves a fixed value. */
const providerOf = (value: unknown) => async (): Promise<unknown> => value;

/** A region provider that fails, as the SDK does when nothing can be resolved. */
const failingProvider = async (): Promise<unknown> => {
	throw new Error('Region is missing');
};

const config = (overrides: Partial<AwsConfig> = {}): AwsConfig => ({
	region: null,
	endpoint: null,
	local: false,
	credentials: 'ambient',
	...overrides,
});

const LOCAL_ENDPOINT = 'http://localhost:4566';

describe('resolveAwsConfig', () => {
	test('prefers AWS_ENDPOINT_URL_LOGS over AWS_ENDPOINT_URL', () => {
		const resolved = resolveAwsConfig({
			AWS_ENDPOINT_URL_LOGS: 'http://logs.local:1234',
			AWS_ENDPOINT_URL: 'http://localhost:4566',
		});
		expect(resolved.endpoint).toBe('http://logs.local:1234');
		expect(resolved.local).toBe(false);
	});

	test('falls back to AWS_ENDPOINT_URL and treats blank overrides as unset', () => {
		expect(resolveAwsConfig({ AWS_ENDPOINT_URL: 'http://localhost:4566' }).endpoint).toBe(
			'http://localhost:4566',
		);
		expect(
			resolveAwsConfig({ AWS_ENDPOINT_URL_LOGS: '  ', AWS_ENDPOINT_URL: 'http://localhost:4566' })
				.endpoint,
		).toBe('http://localhost:4566');
	});

	test('returns null endpoint and local=false without an override', () => {
		const resolved = resolveAwsConfig({});
		expect(resolved.endpoint).toBeNull();
		expect(resolved.local).toBe(false);
	});

	test.each([
		['http://localhost:4566', true],
		['http://127.0.0.1:4566', true],
		['http://[::1]:4566', true],
		['http://floci.localhost:4566', true],
		['https://localstack:4566', true],
		['http://localhost:4566/prefix', true],
		['https://logs.us-east-1.amazonaws.com', false],
		['https://cloudwatch.us-west-2.amazonaws.com', false],
	])('detects local endpoint %s -> %s', (endpoint, expected) => {
		expect(resolveAwsConfig({ AWS_ENDPOINT_URL: endpoint }).local).toBe(expected);
	});

	test('resolves the region with the documented precedence', () => {
		expect(resolveAwsConfig({ AWS_REGION: 'eu-west-1' }, 'ap-south-1').region).toBe('ap-south-1');
		expect(
			resolveAwsConfig({ AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'us-west-2' }).region,
		).toBe('eu-west-1');
		expect(resolveAwsConfig({ AWS_DEFAULT_REGION: 'us-west-2' }).region).toBe('us-west-2');
		expect(resolveAwsConfig({ AWS_REGION: ' eu-central-1 ' }).region).toBe('eu-central-1');
	});

	test.each([
		['AWS_ACCESS_KEY_ID'],
		['AWS_PROFILE'],
		['AWS_SHARED_CREDENTIALS_FILE'],
		['AWS_CONFIG_FILE'],
		['AWS_WEB_IDENTITY_TOKEN_FILE'],
		['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'],
		['AWS_CONTAINER_CREDENTIALS_FULL_URI'],
		['AWS_ROLE_ARN'],
	])('keeps ambient credentials when %s is set for a local endpoint', (key) => {
		const resolved = resolveAwsConfig({ AWS_ENDPOINT_URL: 'http://localhost:4566', [key]: 'x' });
		expect(resolved.local).toBe(true);
		expect(resolved.credentials).toBe('ambient');
	});

	test('uses the emulator keys for a local endpoint without ambient credentials', () => {
		const resolved = resolveAwsConfig({ AWS_ENDPOINT_URL: 'http://localhost:4566' });
		expect(resolved.local).toBe(true);
		expect(resolved.credentials).toBe('emulator-default');
		expect(resolveAwsConfig({ AWS_ENDPOINT_URL: 'http://floci.local:4566' }).credentials).toBe(
			'emulator-default',
		);
	});

	test('ignores blank credential variables', () => {
		const resolved = resolveAwsConfig({
			AWS_ENDPOINT_URL: 'http://localhost:4566',
			AWS_ACCESS_KEY_ID: '   ',
			AWS_PROFILE: '',
		});
		expect(resolved.credentials).toBe('emulator-default');
	});

	test('never uses the emulator keys for a non-local endpoint', () => {
		expect(resolveAwsConfig({}).credentials).toBe('ambient');
		expect(resolveAwsConfig({ AWS_ACCESS_KEY_ID: 'AKIAREAL' }).credentials).toBe('ambient');
		expect(
			resolveAwsConfig({ AWS_ENDPOINT_URL: 'https://logs.us-east-1.amazonaws.com' }).credentials,
		).toBe('ambient');
	});

	test('exposes the documented throwaway keys', () => {
		expect(EMULATOR_CREDENTIALS).toEqual({ accessKeyId: 'test', secretAccessKey: 'test' });
	});

	test('returns a null region when nothing is configured', () => {
		expect(resolveAwsConfig({}).region).toBeNull();
		expect(resolveAwsConfig({ AWS_REGION: '  ', AWS_DEFAULT_REGION: '  ' }).region).toBeNull();
		expect(resolveAwsConfig({}, '   ').region).toBeNull();
		expect(resolveAwsConfig({}, null).region).toBeNull();
	});
});

describe('parseRegionParam', () => {
	test('accepts region and local-zone codes', () => {
		expect(parseRegionParam('us-east-1')).toEqual({ ok: true, region: 'us-east-1' });
		expect(parseRegionParam('us-west-2-lax-1a')).toEqual({ ok: true, region: 'us-west-2-lax-1a' });
		expect(parseRegionParam(' eu-west-1 ')).toEqual({ ok: true, region: 'eu-west-1' });
	});

	test('treats missing and blank values as "not supplied"', () => {
		expect(parseRegionParam(null)).toEqual({ ok: true, region: null });
		expect(parseRegionParam(undefined)).toEqual({ ok: true, region: null });
		expect(parseRegionParam('')).toEqual({ ok: true, region: null });
		expect(parseRegionParam('   ')).toEqual({ ok: true, region: null });
	});

	test.each([['US-EAST-1'], ['us_east_1'], ['us east 1'], ['us-east-1!'], ['a'.repeat(65)]])(
		'rejects %s',
		(value) => {
			expect(parseRegionParam(value).ok).toBe(false);
		},
	);

	test('accepts a 64 character code', () => {
		expect(parseRegionParam('a'.repeat(64))).toEqual({ ok: true, region: 'a'.repeat(64) });
	});
});

describe('createLogsClient', () => {
	test('passes region, endpoint and maxAttempts to the SDK', async () => {
		const client = createLogsClient({
			region: 'eu-west-1',
			endpoint: LOCAL_ENDPOINT,
			local: true,
			credentials: 'ambient',
		});
		expect(client).toBeInstanceOf(CloudWatchLogsClient);
		expect(await client.config.region()).toBe('eu-west-1');
		const maxAttempts = client.config.maxAttempts as () => Promise<number>;
		expect(await maxAttempts()).toBe(3);
		const endpointProvider = client.config.endpoint as () => Promise<{
			hostname?: string;
			port?: number;
		}>;
		const endpoint = await endpointProvider();
		expect(endpoint.hostname).toBe('localhost');
		expect(endpoint.port).toBe(4566);
		client.destroy();
	});

	test('signs local emulator requests with the throwaway keys', async () => {
		const resolved = resolveAwsConfig({ AWS_ENDPOINT_URL: LOCAL_ENDPOINT });
		expect(resolved.credentials).toBe('emulator-default');
		const client = createLogsClient(resolved);
		expect(await client.config.credentials()).toEqual(EMULATOR_CREDENTIALS);
		client.destroy();
	});

	test('keeps the ambient chain for a local endpoint that has credentials', async () => {
		nodeEnv.AWS_ACCESS_KEY_ID = 'AKIALOCALTEST';
		nodeEnv.AWS_SECRET_ACCESS_KEY = 'local-secret';
		const resolved = resolveAwsConfig({ ...nodeEnv, AWS_ENDPOINT_URL: LOCAL_ENDPOINT });
		expect(resolved.credentials).toBe('ambient');
		const client = createLogsClient(resolved);
		const credentials = await client.config.credentials();
		expect(credentials.accessKeyId).toBe('AKIALOCALTEST');
		expect(credentials.accessKeyId).not.toBe(EMULATOR_CREDENTIALS.accessKeyId);
		client.destroy();
	});

	test('keeps the ambient chain for a real AWS endpoint', async () => {
		nodeEnv.AWS_ACCESS_KEY_ID = 'AKIAREALTEST';
		nodeEnv.AWS_SECRET_ACCESS_KEY = 'real-secret';
		const resolved = resolveAwsConfig({ ...nodeEnv });
		expect(resolved.credentials).toBe('ambient');
		expect(resolved.endpoint).toBeNull();
		const client = createLogsClient(resolved);
		const credentials = await client.config.credentials();
		expect(credentials.accessKeyId).toBe('AKIAREALTEST');
		client.destroy();
	});

	test('omits the endpoint for real AWS', () => {
		const client = createLogsClient(config({ region: 'us-east-1' }));
		expect(client.config.endpoint).toBeUndefined();
		client.destroy();
	});

	test('leaves the region unset so the SDK can resolve it', async () => {
		const previous = nodeEnv.AWS_REGION;
		nodeEnv.AWS_REGION = 'ap-southeast-2';
		try {
			const client = createLogsClient(config());
			expect(await client.config.region()).toBe('ap-southeast-2');
			client.destroy();
		} finally {
			if (previous === undefined) delete nodeEnv.AWS_REGION;
			else nodeEnv.AWS_REGION = previous;
		}
	});

	test('never invents a region', async () => {
		const previous = nodeEnv.AWS_REGION;
		delete nodeEnv.AWS_REGION;
		try {
			const client = createLogsClient(config());
			let resolved: string | null = null;
			try {
				resolved = String(await client.config.region());
			} catch {
				// Nothing ambient to resolve: the SDK provider throws instead of inventing a region.
			}
			expect(resolved).not.toBe(FALLBACK_REGION);
			client.destroy();
		} finally {
			if (previous !== undefined) nodeEnv.AWS_REGION = previous;
		}
	});

	test('keeps credentials ambient', async () => {
		nodeEnv.AWS_ACCESS_KEY_ID = 'AKIAAMBIENTTEST';
		nodeEnv.AWS_SECRET_ACCESS_KEY = 'ambient-secret';
		const client = createLogsClient(config({ region: 'us-east-1' }));
		const credentials = await client.config.credentials();
		expect(credentials.accessKeyId).toBe('AKIAAMBIENTTEST');
		expect(credentials.secretAccessKey).toBe('ambient-secret');
		client.destroy();
	});
});

describe('resolveEffectiveRegion', () => {
	test('returns the configured region without asking the client', async () => {
		const provider = vi.fn<() => Promise<string>>(async () => 'us-west-1');
		const effective = await resolveEffectiveRegion(
			fakeClient(provider),
			config({ region: 'eu-central-1' }),
		);
		expect(effective).toBe('eu-central-1');
		expect(provider).not.toHaveBeenCalled();
	});

	test('asks the client provider when no region is configured', async () => {
		const provider = vi.fn<() => Promise<string>>(async () => 'us-west-1');
		expect(await resolveEffectiveRegion(fakeClient(provider), config())).toBe('us-west-1');
		expect(provider).toHaveBeenCalledTimes(1);
	});

	test('trims the provider value', async () => {
		expect(await resolveEffectiveRegion(fakeClient(providerOf(' us-east-2 ')), config())).toBe(
			'us-east-2',
		);
	});

	test('falls back to FALLBACK_REGION when the provider rejects', async () => {
		expect(await resolveEffectiveRegion(fakeClient(failingProvider), config())).toBe(
			FALLBACK_REGION,
		);
		expect(FALLBACK_REGION).toBe('us-east-1');
	});

	test('falls back for a blank or non-string provider value', async () => {
		expect(await resolveEffectiveRegion(fakeClient(providerOf('   ')), config())).toBe(
			FALLBACK_REGION,
		);
		expect(await resolveEffectiveRegion(fakeClient(providerOf(undefined)), config())).toBe(
			FALLBACK_REGION,
		);
	});
});

describe('describeAwsError', () => {
	test('maps a missing region to actionable guidance', () => {
		const described = describeAwsError(new Error('Region is missing'));
		expect(described).toEqual({ message: MISSING_REGION_MESSAGE, code: 'missing-region' });
	});

	test.each([
		['Region is not configured'],
		['region is required'],
		['Missing region in the request'],
		['No region is configured for this profile'],
		['Region not set'],
		// What the SDK says when AWS_REGION is an empty string.
		['Region not accepted: region="" is not a valid hostname component'],
	])('classifies %s', (message) => {
		const described = describeAwsError(new Error(message));
		expect(described.code).toBe('missing-region');
		expect(described.message).toBe(MISSING_REGION_MESSAGE);
	});

	test('classifies a RegionProviderError by name', () => {
		const described = describeAwsError(
			Object.assign(new Error('unknown'), { name: 'RegionProviderError' }),
		);
		expect(described.code).toBe('missing-region');
	});

	test('maps missing credentials', () => {
		const described = describeAwsError(
			Object.assign(new Error('Could not load credentials from any providers'), {
				name: 'CredentialsProviderError',
			}),
		);
		expect(described.code).toBe('missing-credentials');
		expect(described.message).toContain('credentials');
	});

	test('maps access denied from the error name and from a 403 status', () => {
		expect(describeAwsError({ name: 'AccessDeniedException', message: 'nope' }).code).toBe(
			'access-denied',
		);
		expect(
			describeAwsError({ name: 'Something', message: 'denied', $metadata: { httpStatusCode: 403 } })
				.code,
		).toBe('access-denied');
	});

	test('maps not found and throttling', () => {
		expect(
			describeAwsError({ name: 'ResourceNotFoundException', message: 'missing', $metadata: {} })
				.code,
		).toBe('not-found');
		expect(
			describeAwsError({ name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }).code,
		).toBe('throttled');
	});

	test('maps network failures to unreachable', () => {
		const refused = describeAwsError(new Error('connect ECONNREFUSED 127.0.0.1:4566'));
		expect(refused.code).toBe('unreachable');
		expect(describeAwsError(new Error('getaddrinfo ENOTFOUND logs.local')).code).toBe(
			'unreachable',
		);
	});

	test('maps unknown values that are not errors', () => {
		const described = describeAwsError(undefined);
		expect(described.code).toBe('unknown');
		expect(described.message.length).toBeGreaterThan(0);
	});

	test('reports an abort as aborted', () => {
		const error = new Error('The operation was aborted');
		error.name = 'AbortError';
		expect(describeAwsError(error).code).toBe('aborted');
	});
});
