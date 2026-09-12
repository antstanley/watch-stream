import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { type RequestEvent } from '@sveltejs/kit';
import { apiError } from '$lib/server/api';
import { getArchive, type LogArchive } from '$lib/server/archive';
import { tailArchivedEvents } from '$lib/server/archive-tail';
import {
	REGION_PARAM_HINT,
	createLogsClient,
	describeAwsError,
	parseRegionParam,
	resolveAwsConfig,
	resolveEffectiveRegion,
	type AwsConfig,
} from '$lib/server/aws';
import { readEnv } from '$lib/server/env';
import { clampPollMs, resolveWindow } from '$lib/server/filter';
import { SOURCE_PARAM_HINT, parseSourceParam } from '$lib/server/source';
import { sseFrame } from '$lib/server/sse';
import { tailLogEvents, type TailBatch } from '$lib/server/tail';
import { LEVEL_PARAM_HINT, parseLevelParam, withLevels } from '$lib/server/level-filter';
import type { LogLevel } from '$lib/log-buffer';
import type {
	StreamEndPayload,
	StreamErrorPayload,
	StreamLogPayload,
	StreamPingPayload,
	StreamReadyPayload,
	StreamSource,
} from '$lib/types';

/** Send a `ping` after this much silence. */
const PING_INTERVAL_MS = 15_000;
/** Stop the stream after this many consecutive failed polls. */
const MAX_CONSECUTIVE_ERRORS = 8;
/** Bounds for the archive `pageSize` parameter. */
const ARCHIVE_PAGE_LIMITS = { min: 1, max: 5000 };
/** Bounds for the archive `max` parameter (events per request). */
const ARCHIVE_MAX_LIMITS = { min: 1, max: 100_000 };

const SSE_HEADERS: Record<string, string> = {
	'content-type': 'text/event-stream; charset=utf-8',
	'cache-control': 'no-cache, no-transform',
	connection: 'keep-alive',
	'x-accel-buffering': 'no',
};

/** One request's event feed plus the resources it owns. */
type Feed = {
	/** Region the feed reads, resolved for the response. */
	region: string;
	/** Batch generator the pump pulls from. */
	generator: AsyncGenerator<TailBatch, void, void>;
	/** Releases what the feed opened; called once, when the stream ends. */
	release: () => void;
};

/** Everything {@link resolveFeed} needs to pick a source. */
type FeedRequest = {
	source: StreamSource;
	config: AwsConfig;
	env: Record<string, string | undefined>;
	logGroupName: string;
	startTime: number;
	/** Inclusive end of a historic window, or `null` for a live tail. */
	endTime: number | null;
	filterPattern: string | undefined;
	/** Archive-only substring search. */
	search: string | null;
	/** Archive-only level filter, or `null` for every level. */
	levels: readonly LogLevel[] | null;
	/** Archive-only page size, or `null` for the tailer default. */
	pageSize: number | null;
	/** Archive-only event cap, or `null` for the tailer default. */
	maxEvents: number | null;
	pollIntervalMs: number;
	signal: AbortSignal;
};

/**
 * Parses a positive integer parameter within `limits`.
 *
 * Returns `null` for a missing value (meaning "use the default") and for an
 * unusable one, so a typo falls back to the default instead of failing the
 * stream; an out-of-range value is clamped rather than rejected.
 */
function parseBoundedInt(
	value: string | null,
	limits: { min: number; max: number },
): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) return null;
	return Math.min(Math.max(Math.round(parsed), limits.min), limits.max);
}

/**
 * Builds the feed for a request.
 *
 * The archive path never creates a CloudWatch client, so browsing history works
 * with no credentials and no network; it does need a region, because archived
 * rows are stored per region. Failures come back as an `apiError` response the
 * route returns unchanged.
 */
async function resolveFeed(request: FeedRequest): Promise<Feed | Response> {
	const { source, config, env, logGroupName, startTime, endTime, signal } = request;

	if (source === 'archive') {
		const region = config.region ?? '';
		if (region === '') {
			return apiError(
				400,
				'Query parameter "region" is required when source=archive',
				'missing-region-param',
			);
		}
		const archive: LogArchive = await getArchive(env);
		return {
			region,
			generator: tailArchivedEvents({
				archive,
				region,
				logGroup: logGroupName,
				startTime,
				endTime: endTime ?? Date.now(),
				search: request.search,
				levels: request.levels,
				// Kept null when absent, so the archive-tail defaults stay the source
				// of truth for a caller that does not page explicitly.
				...(request.pageSize === null ? {} : { pageSize: request.pageSize }),
				...(request.maxEvents === null ? {} : { maxEvents: request.maxEvents }),
				signal,
			}),
			release: () => undefined,
		};
	}

	let client: CloudWatchLogsClient;
	try {
		client = createLogsClient(config);
	} catch (error) {
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	}
	let region: string;
	try {
		region = await resolveEffectiveRegion(client, config);
	} catch (error) {
		client.destroy();
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	}
	return {
		region,
		generator: tailLogEvents({
			client,
			logGroupName,
			startTime,
			endTime,
			pollIntervalMs: request.pollIntervalMs,
			filterPattern: request.filterPattern,
			signal,
			maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
		}),
		release: () => client.destroy(),
	};
}

/**
 * `GET /api/stream` - server-sent events for one log group.
 *
 * Emits `ready` first, then `log` per batch, `ping` after 15 s of silence and
 * a final `end`. `source=cloudwatch` (the default) polls CloudWatch Logs with
 * the ambient credentials; `source=archive` replays the local DuckDB archive and
 * needs neither credentials nor a region parameter resolution.
 *
 * The stream is cancelled through `request.signal`, and every timer and listener
 * is removed so the dev server can exit.
 */
export const GET = async ({ url, request }: RequestEvent): Promise<Response> => {
	const logGroupName = url.searchParams.get('group')?.trim() ?? '';
	if (logGroupName.length === 0) {
		return apiError(400, 'Query parameter "group" is required', 'missing-group');
	}

	const parsedRegion = parseRegionParam(url.searchParams.get('region'));
	if (!parsedRegion.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');

	const source = parseSourceParam(url.searchParams.get('source'));
	if (source === null) return apiError(400, SOURCE_PARAM_HINT, 'invalid-source');

	const env = readEnv();
	const config = resolveAwsConfig(env, parsedRegion.region);
	const filterPattern = url.searchParams.get('filterPattern')?.trim();
	const search = url.searchParams.get('search')?.trim() ?? '';
	const levels = parseLevelParam(url.searchParams.get('level'));
	if (levels === undefined) return apiError(400, LEVEL_PARAM_HINT, 'invalid-level');
	if (levels !== null && source !== 'archive') {
		return apiError(
			400,
			'The "level" filter applies to source=archive; use filterPattern to filter CloudWatch',
			'invalid-level',
		);
	}
	const streamWindow = resolveWindow({
		// The archive holds a fixed window, so a request without a mode is historic.
		mode: url.searchParams.get('mode') ?? (source === 'archive' ? 'historic' : null),
		range: url.searchParams.get('range'),
		from: url.searchParams.get('from'),
		to: url.searchParams.get('to'),
		startTime: url.searchParams.get('startTime'),
		lookback: url.searchParams.get('lookback'),
		now: Date.now(),
	});
	if (!streamWindow.ok) return apiError(400, streamWindow.message, streamWindow.code);
	if (source === 'archive' && streamWindow.mode === 'live') {
		return apiError(
			400,
			'The local archive only serves historic windows: use mode=historic, or source=cloudwatch to tail live',
			'invalid-mode',
		);
	}

	const bodyAbort = new AbortController();
	const feed = await resolveFeed({
		source,
		config,
		env,
		logGroupName,
		startTime: streamWindow.startTime,
		endTime: streamWindow.endTime,
		filterPattern,
		search: search.length === 0 ? null : search,
		levels,
		pageSize: parseBoundedInt(url.searchParams.get('pageSize'), ARCHIVE_PAGE_LIMITS),
		maxEvents: parseBoundedInt(url.searchParams.get('max'), ARCHIVE_MAX_LIMITS),
		pollIntervalMs: clampPollMs(url.searchParams.get('poll')),
		signal: bodyAbort.signal,
	});
	if (feed instanceof Response) return feed;

	// Only the CloudWatch feed writes: reading the archive must not touch it.
	const archive = source === 'cloudwatch' ? await getArchive(env) : null;

	const encoder = new TextEncoder();
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	let pingTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanedUp = false;

	const clearPing = (): void => {
		if (pingTimer !== undefined) {
			clearTimeout(pingTimer);
			pingTimer = undefined;
		}
	};

	const armPing = (): void => {
		if (closed) return;
		clearPing();
		pingTimer = setTimeout(() => {
			pingTimer = undefined;
			if (closed) return;
			const payload: StreamPingPayload = { at: Date.now() };
			enqueue(sseFrame('ping', payload), false);
			armPing();
		}, PING_INTERVAL_MS);
		(pingTimer as { unref?: () => void }).unref?.();
	};

	const enqueue = (chunk: string, rearm = true): void => {
		if (closed || streamController === undefined) return;
		try {
			streamController.enqueue(encoder.encode(chunk));
		} catch {
			// The consumer closed the stream between the flag check and the write.
			closed = true;
			return;
		}
		if (rearm) armPing();
	};

	const closeStream = (): void => {
		closed = true;
		try {
			streamController?.close();
		} catch {
			// Already closed or errored.
		}
	};

	const writeEnd = (reason: string): void => {
		clearPing();
		const payload: StreamEndPayload = { reason };
		// Best effort: the client may already be gone, so errors are swallowed.
		try {
			streamController?.enqueue(encoder.encode(sseFrame('end', payload)));
		} catch {
			// Enqueue after close.
		}
		closeStream();
	};

	const onAbort = (): void => {
		bodyAbort.abort();
	};

	const cleanup = (): void => {
		if (cleanedUp) return;
		cleanedUp = true;
		clearPing();
		request.signal.removeEventListener('abort', onAbort);
		feed.release();
	};

	const pump = async (): Promise<void> => {
		let consecutiveErrors = 0;
		let reason = 'completed';
		try {
			for await (const batch of feed.generator) {
				if (closed || bodyAbort.signal.aborted) break;
				if (batch.type === 'events') {
					// Live events carry no level, so the server detects it with the same
					// detector the archive stores. Archived events already hold the level
					// that was stored (possibly `null`), so they are passed through.
					const events = source === 'cloudwatch' ? withLevels(batch.events) : batch.events;
					const payload: StreamLogPayload = { events };
					consecutiveErrors = 0;
					enqueue(sseFrame('log', payload));
					// Archiving is part of the stream: awaiting keeps the order and lets
					// the archive serialise its own writes. It never throws.
					if (archive !== null) await archive.record(feed.region, logGroupName, events);
				} else if (batch.type === 'end') {
					// A finite (historic) window reports why it finished; a live tail
					// only ends because the client went away.
					reason = batch.reason;
					break;
				} else {
					const payload: StreamErrorPayload = { message: batch.message };
					if (batch.code !== undefined) payload.code = batch.code;
					consecutiveErrors += 1;
					enqueue(sseFrame('error', payload));
				}
			}
			if (reason === 'completed') {
				if (bodyAbort.signal.aborted) reason = 'client-disconnected';
				else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) reason = 'repeated-errors';
			}
		} catch (error) {
			const described = describeAwsError(error);
			const payload: StreamErrorPayload = { message: described.message };
			if (described.code !== undefined) payload.code = described.code;
			enqueue(sseFrame('error', payload));
			reason = 'failed';
		} finally {
			cleanup();
		}
		writeEnd(reason);
	};

	request.signal.addEventListener('abort', onAbort, { once: true });

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
			const payload: StreamReadyPayload = {
				region: feed.region,
				logGroupName,
				// The archive reads a local file, so there is no AWS endpoint to report.
				endpoint: source === 'archive' ? null : config.endpoint,
				source,
				startTime: streamWindow.startTime,
				endTime: streamWindow.endTime,
				mode: streamWindow.mode,
				preset: streamWindow.preset,
				clamped: streamWindow.clamped,
			};
			enqueue(sseFrame('ready', payload));
			armPing();
			void pump();
		},
		cancel() {
			bodyAbort.abort();
			clearPing();
			closeStream();
			cleanup();
		},
	});

	return new Response(stream, { headers: SSE_HEADERS });
};
