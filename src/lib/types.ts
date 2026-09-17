import type { LogLevel } from './log-buffer';

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
	/** Archive listings only: events held locally for this group. */
	archivedEvents?: number;
	/** Archive listings only: oldest archived event, epoch milliseconds. */
	archivedOldest?: number;
	/** Archive listings only: newest archived event, epoch milliseconds. */
	archivedNewest?: number;
};

/**
 * Where a view gets its events, and where the group list comes from.
 *
 * `cloudwatch` reads the live API with ambient credentials; `archive` reads the
 * local DuckDB file and needs no AWS access at all.
 */
export type StreamSource = 'cloudwatch' | 'archive';

export type LogGroupsResponse = {
	region: string;
	endpoint: string | null;
	/** Where the list came from; the archive needs no credentials. */
	source: StreamSource;
	groups: LogGroupSummary[];
};

/** Answer of `GET /api/archive` - what the local DuckDB archive holds. */
export type ArchiveStatusResponse = {
	/** Database file in use. */
	path: string;
	/** False when DuckDB is missing or the file cannot be opened. */
	available: boolean;
	/** Why the archive is unavailable, or the last failure, or `null`. */
	error: string | null;
	/** Size of the database file, or `null` when it does not exist yet. */
	bytes: number | null;
	/** Archived events. */
	rows: number;
	/** Distinct log groups. */
	groups: number;
	/** Distinct regions. */
	regions: number;
	/** Oldest archived event, epoch ms. */
	oldest: number | null;
	/** Newest archived event, epoch ms. */
	newest: number | null;
};

export type LogEventDto = {
	/** CloudWatch event id; used for de-duplication on the client and server. */
	id: string | null;
	/** Event timestamp in epoch milliseconds. */
	timestamp: number;
	message: string;
	streamName?: string;
	ingestionTime?: number;
	/**
	 * Severity detected on the server (`error` | `warn` | `info` | `debug`), or
	 * `null` when the line carried no level. Absent means "not detected here", and
	 * the client falls back to its own guess.
	 */
	level?: LogLevel | null;
	/**
	 * Request id the line belongs to, as detected on the server, or `null` when it
	 * has none. Absent means "not detected here", and the client falls back to its
	 * own detection. Lines that share an id are one request: the log view groups
	 * them into one row and the chart counts them once.
	 */
	requestId?: string | null;
	/** Log group the event belongs to; sent when more than one group is in play. */
	group?: string;
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
	/** First selected group; kept for single-group clients. */
	logGroupName: string;
	/** Every selected group, in request order. */
	groups: string[];
	endpoint: string | null;
	/** Where this stream reads from. */
	source: StreamSource;
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

/** Level of a chart series; `unknown` counts events whose level was not detected. */
export type SeriesLevel = LogLevel | 'unknown';

export type SeriesMetric = 'count' | 'duration';

/** One bucket of the chart: events of one level, in one group, in one time bucket. */
export type SeriesPoint = {
	/** Bucket start, epoch milliseconds. */
	t: number;
	/** Log group the events came from. */
	group: string;
	level: SeriesLevel;
	events: number;
	/** Present for one-request duration points; events is then 1. */
	durationMs?: number;
	requestId?: string;
};

/** Events per group over the whole window. */
export type SeriesGroupTotal = { group: string; events: number };

/** Events per level over the whole window. */
export type SeriesLevelTotal = { level: SeriesLevel; events: number };

/**
 * What one chart mark stands for.
 *
 * `event` counts lines; `request` counts requests, so an incident reads as the
 * number of affected requests rather than the number of lines they wrote.
 */
export type SeriesGroupBy = 'event' | 'request';

/** Answer of `GET /api/series` - the data behind the chart. */
export type SeriesResponse = {
	/** What one mark stands for, echoing the `by` parameter. */
	groupBy: SeriesGroupBy;
	/** Inclusive start of the window, epoch ms. */
	from: number;
	/** Inclusive end of the window, epoch ms. */
	to: number;
	/** Bucket width in ms. */
	bucketMs: number;
	/** Totals per level, in severity order. */
	levels: SeriesLevelTotal[];
	/** Totals per group, busiest first. */
	groups: SeriesGroupTotal[];
	points: SeriesPoint[];
	totals: { events: number; points: number };
};
