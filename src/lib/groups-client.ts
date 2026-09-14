/**
 * Browser-side fetch helpers for the watch-stream JSON API (`/api/health`, `/api/regions`,
 * `/api/log-groups`, `/api/archive`). Every helper throws {@link ApiError} on a non-2xx response so
 * the UI can show the API `error` message instead of an opaque failure.
 */

import { REGION_CODES } from './regions';
import type {
	ApiErrorBody,
	ArchiveStatusResponse,
	HealthResponse,
	LogGroupSummary,
	LogGroupsResponse,
	RegionsResponse,
	SeriesGroupBy,
	SeriesResponse,
	StreamSource,
} from './types';

/** Region list used by the picker before (or instead of) `/api/regions`. */
export const DEFAULT_REGIONS: readonly string[] = REGION_CODES;

/**
 * Injectable `fetch`, so tests can drive the helpers without a server.
 * Only the string-URL form is used by these helpers.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options shared by every request helper. */
export type RequestOptions = {
	/** Aborts an in-flight request, for example when the region changes again. */
	signal?: AbortSignal;
	/** Defaults to the global `fetch`. */
	fetchImpl?: FetchLike;
};

/** Options for {@link fetchLogGroups}. */
export type LogGroupsQuery = RequestOptions & {
	region: string;
	/** Defaults to `cloudwatch`; `archive` lists the local DuckDB groups instead. */
	source?: StreamSource;
	prefix?: string;
	limit?: number;
};

/** Options for {@link fetchSeries}. */
export type SeriesQuery = RequestOptions & {
	region: string;
	/** Log groups to count; one or many. */
	groups: readonly string[];
	/** Inclusive start of the window, epoch ms. */
	from: number;
	/** Inclusive end of the window, epoch ms. */
	to: number;
	/** Levels to count; empty or omitted counts every level. */
	levels?: readonly string[];
	/** Explicit bucket width in ms, or omitted for the server's automatic width. */
	bucketMs?: number;
	/** Count requests instead of lines; omitted counts lines. */
	by?: SeriesGroupBy;
};

/** Error carrying the parsed `ApiErrorBody` returned by the API. */
export class ApiError extends Error {
	/** HTTP status, or `0` when the request never reached the server. */
	readonly status: number;
	/** Optional machine-readable code from the API. */
	readonly code?: string;
	/** Optional extra detail from the API. */
	readonly details?: string;

	constructor(
		message: string,
		options: { status?: number; code?: string; details?: string; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = 'ApiError';
		this.status = options.status ?? 0;
		this.code = options.code;
		this.details = options.details;
	}
}

/** Reads a string field from an unknown JSON value. */
function readField(value: unknown, key: string): string | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === 'string' ? field : undefined;
}

/** Type guard for an API error body. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
	return readField(value, 'error') !== undefined;
}

/** Extracts the API `error` message, falling back when the body has none. */
export function apiErrorMessage(value: unknown, fallback = 'Unexpected API error'): string {
	return readField(value, 'error') ?? fallback;
}

/** Builds the `/api/log-groups` URL, including only the parameters that are set. */
export function buildLogGroupsUrl(query: {
	region?: string;
	source?: StreamSource;
	prefix?: string;
	limit?: number;
}): string {
	const search = new URLSearchParams();
	if (query.region) search.set('region', query.region);
	if (query.source) search.set('source', query.source);
	if (query.prefix) search.set('prefix', query.prefix);
	if (typeof query.limit === 'number' && Number.isFinite(query.limit)) {
		search.set('limit', String(query.limit));
	}
	const suffix = search.toString();
	return suffix === '' ? '/api/log-groups' : `/api/log-groups?${suffix}`;
}

/** Builds the `/api/series` URL for a query. */
function buildSeriesUrl(query: {
	region?: string;
	groups?: readonly string[];
	from?: number;
	to?: number;
	levels?: readonly string[];
	bucketMs?: number;
	by?: SeriesGroupBy;
}): string {
	const search = new URLSearchParams();
	if (query.region) search.set('region', query.region);
	search.set('source', 'archive');
	const groups = (query.groups ?? []).filter((name) => name.length > 0);
	if (groups.length > 0) search.set('groups', groups.join(','));
	if (typeof query.from === 'number' && Number.isFinite(query.from)) {
		search.set('from', String(Math.round(query.from)));
	}
	if (typeof query.to === 'number' && Number.isFinite(query.to)) {
		search.set('to', String(Math.round(query.to)));
	}
	const levels = (query.levels ?? []).filter((level) => level.length > 0);
	if (levels.length > 0) search.set('level', levels.join(','));
	if (query.by === 'request' || query.by === 'event') search.set('by', query.by);
	if (typeof query.bucketMs === 'number' && Number.isFinite(query.bucketMs) && query.bucketMs > 0) {
		search.set('bucket', String(Math.round(query.bucketMs)));
	}
	return `/api/series?${search.toString()}`;
}

/** `GET /api/series` - bucketed event counts for the chart. */
export function fetchSeries(query: SeriesQuery): Promise<SeriesResponse> {
	return getJson<SeriesResponse>(buildSeriesUrl(query), query);
}

/** True for an abort, which is a normal way to cancel a request. */
function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

/** Performs a JSON request and maps failures onto {@link ApiError}. */
async function getJson<T>(url: string, options: RequestOptions): Promise<T> {
	const fetchImpl = options.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { accept: 'application/json' },
			signal: options.signal,
		});
	} catch (cause) {
		if (isAbort(cause)) throw cause;
		throw new ApiError(`Could not reach ${url}.`, { cause });
	}

	const text = await response.text();
	let body: unknown = null;
	if (text.trim() !== '') {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}

	if (!response.ok) {
		throw new ApiError(apiErrorMessage(body, `Request to ${url} failed with ${response.status}.`), {
			status: response.status,
			code: readField(body, 'code'),
			details: readField(body, 'details'),
		});
	}

	// The API contract fixes the shape of every successful response.
	return body as T;
}

/** `GET /api/regions` - region list for the picker. */
export function fetchRegions(options: RequestOptions = {}): Promise<RegionsResponse> {
	return getJson<RegionsResponse>('/api/regions', options);
}

/**
 * Credential source reported by `GET /api/health`: `ambient` is the AWS SDK default provider
 * chain, `emulator-default` means the local emulator's throwaway keys were used.
 */
export type CredentialsMode = HealthResponse['credentials'];

/** `GET /api/health` - resolved region, endpoint, emulator flag and credentials mode. */
export function fetchHealth(options: RequestOptions = {}): Promise<HealthResponse> {
	return getJson<HealthResponse>('/api/health', options);
}

/**
 * `GET /api/log-groups` - log groups for a region, from CloudWatch or the local archive.
 *
 * The archive list needs no credentials and never reaches AWS.
 */
export function fetchLogGroups(query: LogGroupsQuery): Promise<LogGroupsResponse> {
	const url = buildLogGroupsUrl(query);
	return getJson<LogGroupsResponse>(url, query);
}

/**
 * `GET /api/archive` - what the local DuckDB archive holds.
 *
 * The route answers 200 even when the archive is off or unreadable, so a failed
 * request means the API itself is unreachable and the caller should just hide
 * the archive view.
 */
export function fetchArchiveStatus(options: RequestOptions = {}): Promise<ArchiveStatusResponse> {
	return getJson<ArchiveStatusResponse>('/api/archive', options);
}

/** Maximum number of log group rows the list renders; the rest is summarised as "showing first". */
export const MAX_GROUP_ROWS = 500;

/** Sorts log groups by name, keeping the input untouched. */
export function sortGroups(groups: readonly LogGroupSummary[]): LogGroupSummary[] {
	return groups.toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Message shown when a region has no log groups at all. */
export function noGroupsMessage(region: string): string {
	return `No log groups found in ${region}. Start floci and run \`pnpm seed\` to create sample groups.`;
}

/** Plain statement of what the archive source shows, used next to the toggle. */
export const ARCHIVE_NOTE =
	'Locally archived events - read from the local DuckDB file, no CloudWatch credentials, historic windows only.';

/** Tooltip for the archive indicator: what it shows and which file backs it. */
export function describeArchive(path: string | null | undefined): string {
	const trimmed = typeof path === 'string' ? path.trim() : '';
	const head = 'Locally archived events instead of live CloudWatch data';
	return trimmed === '' ? head : `${head} (${trimmed})`;
}

/** Message shown when the archive holds nothing for a region. */
export function noArchivedGroupsMessage(region: string): string {
	const where = region === '' ? 'this region' : region;
	return `Nothing archived for ${where} yet - stream a group from CloudWatch once and it will appear here.`;
}

/** Drops a trailing period so an appended sentence does not double up. */
function trimSentence(text: string): string {
	return text.trim().replace(/\.+$/, '');
}

/** Adds region context to a failed group list request. */

export function describeGroupsError(region: string, error: unknown): string {
	if (error instanceof ApiError) {
		const details = error.details ? ` ${error.details}` : '';
		return `Could not list log groups in ${region}: ${trimSentence(error.message)}.${details}`;
	}
	const detail = error instanceof Error && error.message !== '' ? error.message : String(error);
	return `Could not reach the watch-stream API for ${region}. ${detail}`;
}

/** Adds group and region context to a stream error payload. */
export function describeStreamError(region: string, group: string | null, message: string): string {
	const where = group === null || group === '' ? region : `${group} in ${region}`;
	return `${message} (${where})`;
}
