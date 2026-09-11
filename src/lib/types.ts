/**
 * Shared wire types between the SvelteKit server routes and the browser UI.
 * Keep this file free of runtime imports so both sides can import it.
 */

export type RegionsResponse = {
	regions: string[];
	defaultRegion: string;
	/** Resolved CloudWatch Logs endpoint, or `null` when talking to real AWS. */
	endpoint: string | null;
};

export type LogGroupSummary = {
	name: string;
	arn?: string;
	storedBytes?: number;
	retentionInDays?: number;
	/** Epoch milliseconds. */
	creationTime?: number;
};

export type LogGroupsResponse = {
	region: string;
	endpoint: string | null;
	groups: LogGroupSummary[];
};

export type LogEventDto = {
	/** CloudWatch event id; used for de-duplication on the client and server. */
	id: string | null;
	/** Event timestamp in epoch milliseconds. */
	timestamp: number;
	message: string;
	streamName?: string;
	ingestionTime?: number;
};

export type ApiErrorBody = {
	error: string;
	code?: string;
	details?: string;
};

export type HealthResponse = {
	ok: boolean;
	/** Region used for requests: explicit config, else the ambient AWS region. */
	region: string;
	endpoint: string | null;
	/** True when the endpoint looks like a local emulator (floci, LocalStack). */
	local: boolean;
	/**
	 * Where credentials come from: `ambient` is the SDK default provider chain,
	 * `emulator-default` means the local emulator's documented throwaway keys
	 * were used because no ambient credentials were configured.
	 */
	credentials: 'ambient' | 'emulator-default';
};

/**
 * Server-sent events emitted by `GET /api/stream`:
 *
 * - `ready` - `{ region, logGroupName, endpoint, startTime, endTime, mode, preset, clamped }`
 * - `log` - `{ events: LogEventDto[] }`
 * - `ping` - `{ at: number }`
 * - `error` - `{ message: string, code?: string }`
 * - `end` - `{ reason: string }`
 */

export type StreamReadyPayload = {
	region: string;
	logGroupName: string;
	endpoint: string | null;
	/** Inclusive start of the window, epoch ms. */
	startTime: number;
	/** Inclusive end of a historic window, or `null` while tailing live. */
	endTime: number | null;
	/** `live` tails new events; `historic` scans the reported window. */
	mode: 'live' | 'historic';
	/** Preset that produced a historic window, or `null`. */
	preset: string | null;
	/** True when the request was clamped to the 14-day or `now` limits. */
	clamped: boolean;
};

export type StreamLogPayload = {
	events: LogEventDto[];
};

export type StreamPingPayload = {
	at: number;
};

export type StreamErrorPayload = {
	message: string;
	code?: string;
};

export type StreamEndPayload = {
	reason: string;
};

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'ended';

/** Answer of `GET /api/identity` - who the resolved credentials belong to. */
export type IdentityResponse = {
	arn: string;
	account: string;
	userId: string;
	region: string;
	endpoint: string | null;
};
