/**
 * SQL and row mapping for the local DuckDB archive.
 *
 * DuckDB is a native dependency and is loaded lazily by `archive.ts`; everything
 * in this file is plain text and pure functions so the archive can be unit
 * tested without the driver. Column order matters: {@link ARCHIVE_INSERT_COLUMNS}
 * is the contract with {@link toArchiveParams}, and the `SELECT` in
 * {@link buildPageQuery} uses the same names as {@link rowsToPage}.
 */
import { createHash } from 'node:crypto';
import { detectLevelWithSource, isLogLevel, type LogLevel } from '$lib/log-buffer';
import type { LogEventDto, SeriesLevel } from '$lib/types';

/** A value that can be bound to a `?` placeholder. */
export type ArchiveParam = string | number | bigint | null;

/**
 * Statements that bring a database file up to the current schema.
 *
 * Every statement is idempotent so an existing archive can be opened by a newer
 * build without a migration step. `seq` orders events by arrival, which keeps
 * paging stable when many events share a millisecond timestamp.
 */
export const ARCHIVE_SCHEMA: readonly string[] = [
	`CREATE SEQUENCE IF NOT EXISTS log_events_seq`,
	`CREATE TABLE IF NOT EXISTS log_events (
		region VARCHAR NOT NULL,
		log_group VARCHAR NOT NULL,
		log_stream VARCHAR,
		event_key VARCHAR NOT NULL,
		event_id VARCHAR,
		timestamp_ms BIGINT NOT NULL,
		ingestion_time_ms BIGINT,
		message VARCHAR NOT NULL,
		level VARCHAR,
		level_source VARCHAR,
		seq BIGINT NOT NULL DEFAULT nextval('log_events_seq'),
		archived_at TIMESTAMP NOT NULL DEFAULT now()
	)`,
	// Additive migration for files written before the level columns existed; a
	// fresh table already has them, and `IF NOT EXISTS` makes both paths safe.
	`ALTER TABLE log_events ADD COLUMN IF NOT EXISTS level VARCHAR`,
	`ALTER TABLE log_events ADD COLUMN IF NOT EXISTS level_source VARCHAR`,
	`CREATE UNIQUE INDEX IF NOT EXISTS log_events_unique ON log_events (region, log_group, event_key)`,
	`CREATE INDEX IF NOT EXISTS log_events_time ON log_events (region, log_group, timestamp_ms)`,
];

/** Columns written by {@link buildInsertSql}, in binding order. */
export const ARCHIVE_INSERT_COLUMNS: readonly string[] = [
	'region',
	'log_group',
	'log_stream',
	'event_key',
	'event_id',
	'timestamp_ms',
	'ingestion_time_ms',
	'message',
	'level',
	'level_source',
];

/** Largest number of rows in one `INSERT`; longer batches are chunked. */
export const ARCHIVE_INSERT_CHUNK = 500;

/** Escape character used with `LIKE`/`ILIKE` so user input cannot inject wildcards. */
const LIKE_ESCAPE = '\\';

/**
 * Stable identity of an event inside one log group.
 *
 * CloudWatch event ids are unique per log group and are reused as the key;
 * events without an id (floci and LocalStack omit them) get a deterministic
 * hash of timestamp, stream and message, so re-scanning the same window is
 * idempotent instead of duplicating rows.
 */
export function archiveEventKey(event: LogEventDto): string {
	if (event.id !== null && event.id.length > 0) return event.id;
	const digest = createHash('sha256')
		.update(`${event.timestamp}\u0000${event.streamName ?? ''}\u0000${event.message}`)
		.digest('hex');
	return `h:${digest.slice(0, 32)}`;
}

/** Renders `count` placeholder rows of ten columns each. */
function placeholderRows(count: number): string {
	const row = `(${ARCHIVE_INSERT_COLUMNS.map(() => '?').join(', ')})`;
	return Array.from({ length: count }, () => row).join(', ');
}

/**
 * Builds a multi-row `INSERT OR IGNORE`, so events already archived are skipped
 * by the unique index instead of raising.
 */
export function buildInsertSql(rowCount: number): string {
	if (!Number.isInteger(rowCount) || rowCount < 1) {
		throw new RangeError(`rowCount must be a positive integer, received ${String(rowCount)}`);
	}
	return `INSERT OR IGNORE INTO log_events (${ARCHIVE_INSERT_COLUMNS.join(', ')}) VALUES ${placeholderRows(rowCount)}`;
}

/** Flattens events into the parameter list {@link buildInsertSql} expects. */
export function toArchiveParams(
	region: string,
	logGroup: string,
	events: readonly LogEventDto[],
): ArchiveParam[] {
	const params: ArchiveParam[] = [];
	for (const event of events) {
		// The level is detected once, on the way in: a declared payload level wins
		// over the text heuristic, and a line with no signal is stored as NULL
		// rather than being labelled `info`.
		const detected = detectLevelWithSource(event.message);
		params.push(
			region,
			logGroup,
			event.streamName ?? null,
			archiveEventKey(event),
			event.id ?? null,
			BigInt(Math.round(event.timestamp)),
			event.ingestionTime === undefined ? null : BigInt(Math.round(event.ingestionTime)),
			event.message,
			detected.level,
			detected.source,
		);
	}
	return params;
}

/** Position of the last row of a page: timestamps repeat, `seq` never does. */
export type ArchiveCursor = { timestamp: number; seq: number };

/** One page of archived events. */
export type ArchivePageRequest = {
	region: string;
	/** Log groups to read; one statement covers all of them. */
	logGroups: readonly string[];
	startTime: number;
	endTime: number;
	/** Case-insensitive substring of the message, or `null` for everything. */
	search?: string | null;
	/** Log stream name prefix, or `null` for every stream. */
	streamPrefix?: string | null;
	/** Levels to include, or `null` for every level. */
	levels?: readonly LogLevel[] | null;
	/** Skip events up to and including this cursor, or `null` for the first page. */
	after?: ArchiveCursor | null;
	limit: number;
};

/** Column list shared by {@link buildPageQuery} and {@link rowsToPage}. */
const PAGE_COLUMNS = `region, log_group, log_stream, event_key, event_id, timestamp_ms, ingestion_time_ms, message, level, level_source, seq`;

/** Escapes `LIKE` metacharacters so a search term is matched literally. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `${LIKE_ESCAPE}${match}`);
}

/**
 * Builds one keyset page of archived events.
 *
 * Ordering is `(timestamp_ms, seq)`, and the cursor compares the same tuple, so
 * pages never repeat or skip a row even when thousands of events share a
 * timestamp.
 */
export function buildPageQuery(request: ArchivePageRequest): {
	sql: string;
	params: ArchiveParam[];
} {
	const limit = Math.max(1, Math.round(request.limit));
	const groups = request.logGroups.length > 0 ? request.logGroups : [''];
	const where: string[] = [
		'region = ?',
		`log_group IN (${groups.map(() => '?').join(', ')})`,
		'timestamp_ms >= ?',
		'timestamp_ms <= ?',
	];
	const params: ArchiveParam[] = [
		request.region,
		...groups,
		BigInt(Math.round(request.startTime)),
		BigInt(Math.round(request.endTime)),
	];

	const search = request.search?.trim() ?? '';
	if (search.length > 0) {
		where.push(`message ILIKE ? ESCAPE '${LIKE_ESCAPE}'`);
		params.push(`%${escapeLike(search)}%`);
	}
	const prefix = request.streamPrefix?.trim() ?? '';
	if (prefix.length > 0) {
		where.push(`log_stream LIKE ? ESCAPE '${LIKE_ESCAPE}'`);
		params.push(`${escapeLike(prefix)}%`);
	}
	const levels = request.levels ?? [];
	if (levels.length > 0) {
		// A level filter is an explicit request for known levels, so rows whose
		// level is NULL are left out rather than silently included.
		where.push(`level IN (${levels.map(() => '?').join(', ')})`);
		params.push(...levels);
	}
	const after = request.after ?? null;
	if (after !== null) {
		where.push('(timestamp_ms > ? OR (timestamp_ms = ? AND seq > ?))');
		params.push(
			BigInt(Math.round(after.timestamp)),
			BigInt(Math.round(after.timestamp)),
			BigInt(Math.round(after.seq)),
		);
	}
	params.push(BigInt(limit));

	return {
		sql: `SELECT ${PAGE_COLUMNS} FROM log_events WHERE ${where.join(' AND ')} ORDER BY timestamp_ms, seq LIMIT ?`,
		params,
	};
}

/** Converts a DuckDB value (which may be a bigint) into a JS number. */
function toNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** Converts a nullable DuckDB string column into `string` or `null`. */
function toNullableString(value: unknown): string | null {
	if (typeof value === 'string') return value.length > 0 ? value : null;
	return null;
}

/** Reads one column from a row object, tolerating case differences. */
function pick(row: Record<string, unknown>, column: string): unknown {
	if (column in row) return row[column];
	const upper = column.toUpperCase();
	if (upper in row) return row[upper];
	return undefined;
}

/**
 * Maps query rows onto wire events plus the cursor of the last row.
 *
 * Rows without a usable timestamp are dropped rather than rendered as 1970.
 */
export function rowsToPage(rows: readonly Record<string, unknown>[]): {
	events: LogEventDto[];
	last: ArchiveCursor | null;
} {
	const events: LogEventDto[] = [];
	let last: ArchiveCursor | null = null;
	for (const row of rows) {
		const timestamp = toNumber(pick(row, 'timestamp_ms'));
		const seq = toNumber(pick(row, 'seq'));
		if (timestamp === null || seq === null) continue;
		const rawLevel = pick(row, 'level');
		const group = toNullableString(pick(row, 'log_group'));
		const event: LogEventDto = {
			id: toNullableString(pick(row, 'event_key')),
			timestamp,
			message: typeof pick(row, 'message') === 'string' ? (pick(row, 'message') as string) : '',
			// Explicit `null` on the wire: the archive knows the line has no level,
			// which is different from a client that never asked.
			level: isLogLevel(rawLevel) ? rawLevel : null,
		};
		if (group !== null) event.group = group;
		const streamName = toNullableString(pick(row, 'log_stream'));
		if (streamName !== null) event.streamName = streamName;
		const ingestionTime = toNumber(pick(row, 'ingestion_time_ms'));
		if (ingestionTime !== null) event.ingestionTime = ingestionTime;
		events.push(event);
		last = { timestamp, seq };
	}
	return { events, last };
}

/** Totals shown by `GET /api/archive`. */
export type ArchiveTotals = {
	rows: number;
	groups: number;
	regions: number;
	oldest: number | null;
	newest: number | null;
};

/** One log group held by the archive. */
export type ArchiveGroupRow = {
	region: string;
	logGroup: string;
	events: number;
	oldest: number | null;
	newest: number | null;
};

/** Aggregate query behind {@link ArchiveTotals}. */
export const ARCHIVE_TOTALS_SQL = `SELECT count(*) AS rows, count(DISTINCT log_group) AS groups, count(DISTINCT region) AS regions, min(timestamp_ms) AS oldest, max(timestamp_ms) AS newest FROM log_events`;

/** Log groups held by the archive, optionally limited to one region. */
export function buildGroupsQuery(region: string | null): {
	sql: string;
	params: ArchiveParam[];
} {
	const where = region === null || region.length === 0 ? '' : 'WHERE region = ?';
	return {
		sql: `SELECT region, log_group, count(*) AS events, min(timestamp_ms) AS oldest, max(timestamp_ms) AS newest FROM log_events ${where} GROUP BY region, log_group ORDER BY region, log_group`,
		params: where === '' ? [] : [region],
	};
}

/** Maps the single row of {@link ARCHIVE_TOTALS_SQL}. */
export function rowToTotals(row: Record<string, unknown> | undefined): ArchiveTotals {
	if (row === undefined) return { rows: 0, groups: 0, regions: 0, oldest: null, newest: null };
	return {
		rows: toNumber(pick(row, 'rows')) ?? 0,
		groups: toNumber(pick(row, 'groups')) ?? 0,
		regions: toNumber(pick(row, 'regions')) ?? 0,
		oldest: toNumber(pick(row, 'oldest')),
		newest: toNumber(pick(row, 'newest')),
	};
}

/** Maps the rows of {@link buildGroupsQuery}. */
export function rowsToGroups(rows: readonly Record<string, unknown>[]): ArchiveGroupRow[] {
	const groups: ArchiveGroupRow[] = [];
	for (const row of rows) {
		const region = pick(row, 'region');
		const logGroup = pick(row, 'log_group');
		if (typeof region !== 'string' || typeof logGroup !== 'string') continue;
		groups.push({
			region,
			logGroup,
			events: toNumber(pick(row, 'events')) ?? 0,
			oldest: toNumber(pick(row, 'oldest')),
			newest: toNumber(pick(row, 'newest')),
		});
	}
	return groups;
}

/** One bucket of the chart series query. */
export type ArchiveSeriesRow = {
	/** Bucket start, epoch ms. */
	t: number;
	group: string;
	/** Level of the events in this bucket; `unknown` when the level is NULL. */
	level: SeriesLevel;
	events: number;
};

/** Request for {@link buildSeriesQuery}. */
export type ArchiveSeriesRequest = {
	region: string;
	logGroups: readonly string[];
	startTime: number;
	endTime: number;
	/** Bucket width in ms; the caller derives it from the window. */
	bucketMs: number;
	/** Levels to count, or `null` for every level. */
	levels?: readonly LogLevel[] | null;
};

/**
 * Builds the bucketed counts behind the chart.
 *
 * One statement returns every series. The bucket is plain integer arithmetic on
 * `timestamp_ms`, so it cannot drift with a time zone; NULL levels are reported
 * as `unknown` rather than dropped; and a level filter matches only rows that
 * carry one of the requested levels.
 */
export function buildSeriesQuery(request: ArchiveSeriesRequest): {
	sql: string;
	params: ArchiveParam[];
} {
	const bucketMs = Math.max(1, Math.round(request.bucketMs));
	const groups = request.logGroups.length > 0 ? request.logGroups : [''];
	const where: string[] = [
		'region = ?',
		`log_group IN (${groups.map(() => '?').join(', ')})`,
		'timestamp_ms >= ?',
		'timestamp_ms <= ?',
	];
	// Bind order follows the statement: the bucket arithmetic appears in the
	// SELECT clause, so its two placeholders come first.
	const params: ArchiveParam[] = [
		BigInt(bucketMs),
		BigInt(bucketMs),
		request.region,
		...groups,
		BigInt(Math.round(request.startTime)),
		BigInt(Math.round(request.endTime)),
	];
	const levels = request.levels ?? [];
	if (levels.length > 0) {
		where.push(`level IN (${levels.map(() => '?').join(', ')})`);
		params.push(...levels);
	}
	return {
		sql: `SELECT CAST(floor(timestamp_ms / ?) * ? AS BIGINT) AS bucket, log_group, coalesce(level, 'unknown') AS level, count(*) AS events FROM log_events WHERE ${where.join(' AND ')} GROUP BY bucket, log_group, level ORDER BY bucket, log_group, level`,
		params,
	};
}

/** Maps the rows of {@link buildSeriesQuery} onto chart points. */
export function rowsToSeries(rows: readonly Record<string, unknown>[]): ArchiveSeriesRow[] {
	const points: ArchiveSeriesRow[] = [];
	for (const row of rows) {
		const t = toNumber(pick(row, 'bucket'));
		const group = pick(row, 'log_group');
		const level = pick(row, 'level');
		if (t === null || typeof group !== 'string') continue;
		points.push({
			t,
			group,
			level: typeof level === 'string' && level.length > 0 ? (level as SeriesLevel) : 'unknown',
			events: toNumber(pick(row, 'events')) ?? 0,
		});
	}
	return points;
}
