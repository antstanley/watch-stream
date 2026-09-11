import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { type RequestEvent } from '@sveltejs/kit';
import { apiError } from '$lib/server/api';
import {
	REGION_PARAM_HINT,
	createLogsClient,
	describeAwsError,
	parseRegionParam,
	resolveAwsConfig,
	resolveEffectiveRegion,
} from '$lib/server/aws';
import { readEnv } from '$lib/server/env';
import { clampPollMs, resolveWindow } from '$lib/server/filter';
import { sseFrame } from '$lib/server/sse';
import { tailLogEvents } from '$lib/server/tail';
import type {
	StreamEndPayload,
	StreamErrorPayload,
	StreamLogPayload,
	StreamPingPayload,
	StreamReadyPayload,
} from '$lib/types';

/** Send a `ping` after this much silence. */
const PING_INTERVAL_MS = 15_000;
/** Stop the stream after this many consecutive failed polls. */
const MAX_CONSECUTIVE_ERRORS = 8;

const SSE_HEADERS: Record<string, string> = {
	'content-type': 'text/event-stream; charset=utf-8',
	'cache-control': 'no-cache, no-transform',
	connection: 'keep-alive',
	'x-accel-buffering': 'no',
};

/**
 * `GET /api/stream` - server-sent events for one log group.
 *
 * Emits `ready` first, then `log` per batch, `ping` after 15 s of silence and
 * a final `end`. The region is optional: without it the tailer uses a client
 * that resolves the region from the ambient AWS configuration. The tailer is
 * cancelled through `request.signal`, and every timer and listener is removed
 * so the dev server can exit.
 */
export const GET = async ({ url, request }: RequestEvent): Promise<Response> => {
	const logGroupName = url.searchParams.get('group')?.trim() ?? '';
	if (logGroupName.length === 0) {
		return apiError(400, 'Query parameter "group" is required', 'missing-group');
	}

	const parsedRegion = parseRegionParam(url.searchParams.get('region'));
	if (!parsedRegion.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');

	const env = readEnv();
	const config = resolveAwsConfig(env, parsedRegion.region);
	const filterPattern = url.searchParams.get('filterPattern')?.trim();
	const streamWindow = resolveWindow({
		mode: url.searchParams.get('mode'),
		range: url.searchParams.get('range'),
		from: url.searchParams.get('from'),
		to: url.searchParams.get('to'),
		startTime: url.searchParams.get('startTime'),
		lookback: url.searchParams.get('lookback'),
		now: Date.now(),
	});
	if (!streamWindow.ok) return apiError(400, streamWindow.message, streamWindow.code);
	const pollIntervalMs = clampPollMs(url.searchParams.get('poll'));

	let client: CloudWatchLogsClient;
	let region: string;
	try {
		client = createLogsClient(config);
		region = await resolveEffectiveRegion(client, config);
	} catch (error) {
		// Never crash: surface region problems as 502 with the ApiErrorBody shape.
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	}
	const encoder = new TextEncoder();
	const bodyAbort = new AbortController();
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
		client.destroy();
	};

	const pump = async (): Promise<void> => {
		let consecutiveErrors = 0;
		let reason = 'completed';
		try {
			for await (const batch of tailLogEvents({
				client,
				logGroupName,
				startTime: streamWindow.startTime,
				endTime: streamWindow.endTime,
				pollIntervalMs,
				filterPattern,
				signal: bodyAbort.signal,
				maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
			})) {
				if (closed || bodyAbort.signal.aborted) break;
				if (batch.type === 'events') {
					const payload: StreamLogPayload = { events: batch.events };
					consecutiveErrors = 0;
					enqueue(sseFrame('log', payload));
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
				region,
				logGroupName,
				endpoint: config.endpoint,
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
