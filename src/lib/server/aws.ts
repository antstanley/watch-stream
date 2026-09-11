import {
	CloudWatchLogsClient,
	type CloudWatchLogsClientConfig,
} from '@aws-sdk/client-cloudwatch-logs';
import { STSClient, type STSClientConfig } from '@aws-sdk/client-sts';

/** Where the client takes its credentials from. */
export type CredentialsSource = 'ambient' | 'emulator-default';

/** Resolved CloudWatch Logs connection settings. */
export type AwsConfig = {
	/** Requested region, or `null` to defer to the ambient AWS configuration. */
	region: string | null;
	/** Custom endpoint, or `null` when talking to real AWS. */
	endpoint: string | null;
	/** True when the endpoint points at a local emulator (floci, LocalStack). */
	local: boolean;
	/**
	 * `ambient` keeps the SDK default provider chain; `emulator-default` uses
	 * {@link EMULATOR_CREDENTIALS} because a local emulator has no credentials.
	 */
	credentials: CredentialsSource;
};

/**
 * Throwaway credentials for local emulators only.
 *
 * floci and LocalStack verify the request signature but accept any non-empty
 * key pair, so these keys make a local endpoint work out of the box.
 */
export const EMULATOR_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' } as const;

/** Environment variables that indicate that ambient credentials are configured. */
const CREDENTIAL_ENV_KEYS = [
	'AWS_ACCESS_KEY_ID',
	'AWS_PROFILE',
	'AWS_SHARED_CREDENTIALS_FILE',
	'AWS_CONFIG_FILE',
	'AWS_WEB_IDENTITY_TOKEN_FILE',
	'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
	'AWS_CONTAINER_CREDENTIALS_FULL_URI',
	'AWS_ROLE_ARN',
] as const;

/** Result of validating the optional `region` query parameter. */
export type ParsedRegionParam = { ok: boolean; region: string | null };

/**
 * Display-only region used when nothing else can be resolved. It is never sent
 * to the SDK.
 */
export const FALLBACK_REGION = 'us-east-1';

/** User-facing hint for a malformed `region` query parameter. */
export const REGION_PARAM_HINT =
	'Invalid region: expected a region code such as us-east-1 or us-west-2-lax-1a';

/** Region codes and local-zone codes only: lowercase letters, digits and dashes. */
const REGION_PATTERN = /^[a-z0-9-]{1,64}$/;
/** Hosts that are always considered local, including the IPv6 loopback form. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
/** Substrings that identify a known local AWS emulator. */
const LOCAL_HINTS = ['floci', 'localstack'];
const MAX_DETAIL_LENGTH = 300;

/** Trims a value and treats blank strings as absent. */
function normalize(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Extracts a lowercase host from an endpoint, tolerating missing schemes. */
function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).hostname.toLowerCase();
	} catch {
		const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(endpoint);
		const host = match?.[1] ?? endpoint;
		return host.toLowerCase();
	}
}

/** True when the endpoint targets a local emulator such as floci or LocalStack. */
function isLocalEndpoint(endpoint: string): boolean {
	const host = hostOf(endpoint);
	if (LOCAL_HOSTS.has(host)) return true;
	return LOCAL_HINTS.some((hint) => host.includes(hint));
}

/** True when any ambient credential source is configured (non-blank) in the environment. */
function hasAmbientCredentials(env: Record<string, string | undefined>): boolean {
	return CREDENTIAL_ENV_KEYS.some((key) => normalize(env[key]) !== null);
}

/**
 * Resolves the region, endpoint, local flag and credential source for CloudWatch Logs.
 *
 * Region precedence: an explicit region parameter, then `AWS_REGION`, then
 * `AWS_DEFAULT_REGION`. When none of them is set the result is `null`, which
 * lets the SDK resolve the region from the ambient AWS configuration (profile,
 * SSO, instance metadata) instead of this app inventing one.
 *
 * Credentials stay `ambient` unless the endpoint is local and no ambient
 * credential source is configured at all, in which case the emulator's
 * throwaway keys are used.
 */
export function resolveAwsConfig(
	env: Record<string, string | undefined>,
	regionParam?: string | null,
): AwsConfig {
	const endpoint = normalize(env.AWS_ENDPOINT_URL_LOGS) ?? normalize(env.AWS_ENDPOINT_URL);
	const region =
		normalize(regionParam) ?? normalize(env.AWS_REGION) ?? normalize(env.AWS_DEFAULT_REGION);
	const local = endpoint !== null && isLocalEndpoint(endpoint);
	const credentials: CredentialsSource =
		local && !hasAmbientCredentials(env) ? 'emulator-default' : 'ambient';
	return { region, endpoint, local, credentials };
}

/**
 * Validates the optional `region` query parameter.
 *
 * A blank value means "not supplied" and is accepted as `null`. Any other
 * value must look like a region code or a local-zone code.
 */
export function parseRegionParam(value: string | null | undefined): ParsedRegionParam {
	const trimmed = typeof value === 'string' ? value.trim() : '';
	if (trimmed.length === 0) return { ok: true, region: null };
	if (!REGION_PATTERN.test(trimmed)) return { ok: false, region: null };
	return { ok: true, region: trimmed };
}

/**
 * Creates a CloudWatch Logs client.
 *
 * Credentials stay ambient unless {@link AwsConfig.credentials} asks for the
 * emulator defaults: this never reads key material from the environment and
 * never sets `credentials` for a real AWS endpoint, so the SDK default provider
 * chain is used unchanged. The region is only set when the caller asked for
 * one, so the SDK can otherwise resolve it from `AWS_REGION`, the shared
 * profile or SSO.
 */
export function createLogsClient(config: AwsConfig): CloudWatchLogsClient {
	const options: CloudWatchLogsClientConfig = { maxAttempts: 3 };
	if (config.region !== null) options.region = config.region;
	if (config.endpoint !== null) options.endpoint = config.endpoint;
	if (config.credentials === 'emulator-default') {
		// Local emulators accept any non-empty key pair (requests are still signed, but the
		// signature is never checked against real IAM). This branch only runs for a local
		// endpoint with no ambient credentials configured, so a real AWS endpoint always
		// keeps the untouched default provider chain.
		options.credentials = EMULATOR_CREDENTIALS;
	}
	return new CloudWatchLogsClient(options);
}

/**
 * Resolves the region to show in responses.
 *
 * Returns the requested region when there is one, otherwise asks the client,
 * whose region provider reads `AWS_REGION`, the profile region and finally the
 * `[default]` profile. The provider call is local (no network request) and it
 * throws when nothing can be found, so any failure falls back to
 * {@link FALLBACK_REGION}: this value is informational and must never break a
 * response.
 */
/** Anything with a resolvable region provider: the Logs and STS clients both qualify. */
export type RegionProvider = { config: { region: () => Promise<string> } };

export async function resolveEffectiveRegion(
	client: RegionProvider,
	config: AwsConfig,
): Promise<string> {
	if (config.region !== null) return config.region;
	try {
		const region: unknown = await client.config.region();
		return typeof region === 'string' && region.trim().length > 0 ? region.trim() : FALLBACK_REGION;
	} catch {
		return FALLBACK_REGION;
	}
}

type ErrorLike = {
	name?: unknown;
	message?: unknown;
	code?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	cause?: unknown;
};

type ErrorFacts = {
	name: string;
	message: string;
	code: string;
	status: number | null;
	haystack: string;
};

const ERROR_MESSAGES: Record<string, string> = {
	aborted: 'The CloudWatch Logs request was aborted',
	'missing-credentials': 'AWS credentials are missing or expired',
	'missing-region':
		'No AWS region is configured. Set AWS_REGION or add a region to your AWS profile.',
	'access-denied': 'Access denied by CloudWatch Logs',
	'not-found': 'The CloudWatch Logs resource was not found',
	unreachable: 'The CloudWatch Logs endpoint is unreachable',
	throttled: 'CloudWatch Logs is throttling requests',
	unknown: 'CloudWatch Logs request failed',
};

/** Codes whose message is user guidance and must not be amended with SDK text. */
const FIXED_MESSAGE_CODES = new Set(['missing-region']);

/** Collects name, message, status and a lowercase search haystack from an error chain. */
function readErrorFacts(error: unknown): ErrorFacts {
	const parts: string[] = [];
	let name = '';
	let message = '';
	let code = '';
	let status: number | null = null;
	let current: unknown = error;

	for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
		if (current instanceof Error) {
			if (name === '') name = current.name;
			if (message === '') message = current.message;
			parts.push(current.name, current.message);
		} else if (typeof current === 'string') {
			if (message === '') message = current;
			parts.push(current);
		} else if (typeof current === 'object') {
			const like = current as ErrorLike;
			if (name === '' && typeof like.name === 'string') name = like.name;
			if (message === '' && typeof like.message === 'string') message = like.message;
			if (code === '' && typeof like.code === 'string') code = like.code;
			if (status === null && typeof like.$metadata?.httpStatusCode === 'number') {
				status = like.$metadata.httpStatusCode;
			}
			if (typeof like.name === 'string') parts.push(like.name);
			if (typeof like.message === 'string') parts.push(like.message);
			if (typeof like.code === 'string') parts.push(like.code);
			current = like.cause;
			continue;
		}
		break;
	}

	return {
		name,
		message: message.trim(),
		code,
		status,
		haystack: parts.join(' ').toLowerCase(),
	};
}

/** True when the error says that no AWS region could be resolved. */
function isRegionFailure(loweredName: string, haystack: string): boolean {
	return (
		loweredName.includes('regionprovider') ||
		loweredName.includes('regionnotset') ||
		loweredName.includes('missingregion') ||
		haystack.includes('region is missing') ||
		haystack.includes('region is not configured') ||
		haystack.includes('region is required') ||
		haystack.includes('missing region') ||
		haystack.includes('no region is configured') ||
		haystack.includes('region not set') ||
		haystack.includes('region must be specified') ||
		// A blank AWS_REGION reaches the SDK as an empty string; it rejects it with
		// `Region not accepted: region="" is not a valid hostname component`.
		haystack.includes('region not accepted') ||
		haystack.includes('is not a valid hostname component')
	);
}

/** Maps a thrown value to a machine-readable error code. */
function classify(facts: ErrorFacts): string {
	const { name, code, status, haystack } = facts;
	const loweredName = name.toLowerCase();

	if (loweredName === 'aborterror' || code === 'ABORT_ERR' || code === 'ERR_CANCELED') {
		return 'aborted';
	}
	if (
		loweredName.includes('credentialsprovider') ||
		loweredName.includes('expiredtoken') ||
		haystack.includes('could not load credentials') ||
		haystack.includes('credential is expired') ||
		haystack.includes('token has expired') ||
		haystack.includes('resolve credentials')
	) {
		return 'missing-credentials';
	}
	if (isRegionFailure(loweredName, haystack)) {
		return 'missing-region';
	}
	if (
		loweredName.includes('accessdenied') ||
		loweredName.includes('invalidclienttokenid') ||
		loweredName.includes('invalidsignature') ||
		loweredName.includes('unrecognizedclient') ||
		loweredName.includes('unauthorized') ||
		loweredName.includes('signaturedoesnotmatch') ||
		status === 401 ||
		status === 403
	) {
		return 'access-denied';
	}
	if (
		loweredName.includes('resourcenotfound') ||
		loweredName.includes('loggroupnotfound') ||
		haystack.includes('does not exist') ||
		status === 404
	) {
		return 'not-found';
	}
	if (
		loweredName.includes('throttl') ||
		loweredName.includes('toomanyrequests') ||
		loweredName.includes('requestlimitexceeded') ||
		status === 429
	) {
		return 'throttled';
	}
	if (
		[
			'econnrefused',
			'econnreset',
			'enotfound',
			'eaiagain',
			'etimedout',
			'ehostunreach',
			'enetunreach',
		].some((token) => haystack.includes(token)) ||
		haystack.includes('connection refused') ||
		haystack.includes('socket hang up') ||
		haystack.includes('fetch failed') ||
		haystack.includes('getaddrinfo') ||
		haystack.includes('network error') ||
		haystack.includes('timeout') ||
		haystack.includes('unreachable')
	) {
		return 'unreachable';
	}
	return 'unknown';
}

/**
 * Turns a thrown SDK or network error into a short human message plus a
 * machine-readable code such as `missing-credentials`, `missing-region` or
 * `unreachable`.
 */
export function describeAwsError(error: unknown): { message: string; code?: string } {
	const facts = readErrorFacts(error);
	const code = classify(facts);
	const base = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.unknown;
	if (FIXED_MESSAGE_CODES.has(code)) return { message: base, code };
	const detail =
		facts.message.length > MAX_DETAIL_LENGTH
			? `${facts.message.slice(0, MAX_DETAIL_LENGTH)}...`
			: facts.message;
	const message =
		detail.length > 0 && !base.toLowerCase().includes(detail.toLowerCase())
			? `${base}: ${detail}`
			: base;
	return { message, code };
}

/**
 * Creates an STS client with the same resolved settings as the Logs client.
 *
 * Used for `GetCallerIdentity`, which answers the question the UI cannot: whose
 * credentials are these, if they work at all.
 */
export function createStsClient(config: AwsConfig): STSClient {
	const options: STSClientConfig = { region: config.region ?? undefined, maxAttempts: 2 };
	if (config.endpoint !== null) options.endpoint = config.endpoint;
	if (config.credentials === 'emulator-default') options.credentials = EMULATOR_CREDENTIALS;
	return new STSClient(options);
}
