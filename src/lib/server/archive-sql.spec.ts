import { describe, expect, test } from 'vitest';
import {
	ARCHIVE_INSERT_CHUNK,
	ARCHIVE_INSERT_COLUMNS,
	ARCHIVE_SCHEMA,
	ARCHIVE_TOTALS_SQL,
	archiveEventKey,
	buildGroupsQuery,
	buildInsertSql,
	buildPageQuery,
	escapeLike,
	rowToTotals,
	rowsToGroups,
	rowsToPage,
	toArchiveParams,
} from './archive-sql';
import type { LogEventDto } from '$lib/types';

const REGION = 'af-south-1';
const GROUP = '/aws/lambda/checkout';
const TS = Date.UTC(2024, 4, 17, 12, 0, 0);

function event(overrides: Partial<LogEventDto> = {}): LogEventDto {
	return { id: 'evt-1', timestamp: TS, message: 'hello', ...overrides };
}

describe('archiveEventKey', () => {
	test('uses the CloudWatch event id when there is one', () => {
		expect(archiveEventKey(event())).toBe('evt-1');
	});

	test('hashes timestamp, stream and message when the id is missing', () => {
		const key = archiveEventKey(event({ id: null, streamName: 's-1' }));
		expect(key.startsWith('h:')).toBe(true);
		expect(key).toHaveLength(34);
		expect(archiveEventKey(event({ id: null, streamName: 's-1' }))).toBe(key);
	});

	test('changes when any part of the hashed content changes', () => {
		const base = archiveEventKey(event({ id: null, streamName: 's-1' }));
		expect(archiveEventKey(event({ id: null, streamName: 's-2' }))).not.toBe(base);
		expect(archiveEventKey(event({ id: null, streamName: 's-1', message: 'other' }))).not.toBe(
			base,
		);
		expect(archiveEventKey(event({ id: null, streamName: 's-1', timestamp: TS + 1 }))).not.toBe(
			base,
		);
	});

	test('treats an empty id as missing', () => {
		expect(archiveEventKey(event({ id: '' })).startsWith('h:')).toBe(true);
	});
});

describe('schema', () => {
	test('is idempotent and keeps the de-duplication index', () => {
		expect(ARCHIVE_SCHEMA.every((statement) => statement.includes('IF NOT EXISTS'))).toBe(true);
		expect(
			ARCHIVE_SCHEMA.some((statement) =>
				statement.includes('CREATE UNIQUE INDEX IF NOT EXISTS log_events_unique'),
			),
		).toBe(true);
		expect(ARCHIVE_SCHEMA.some((statement) => statement.includes('log_events_time'))).toBe(true);
		// The level columns are created for new files and migrated into old ones.
		expect(ARCHIVE_SCHEMA.some((statement) => statement.includes('level VARCHAR'))).toBe(true);
		expect(
			ARCHIVE_SCHEMA.some((statement) =>
				statement.includes('ALTER TABLE log_events ADD COLUMN IF NOT EXISTS level_source VARCHAR'),
			),
		).toBe(true);
	});
});

describe('buildInsertSql', () => {
	test('emits one placeholder row per event, in column order', () => {
		const sql = buildInsertSql(2);
		expect(sql.startsWith('INSERT OR IGNORE INTO log_events (')).toBe(true);
		expect(sql).toContain(`(${ARCHIVE_INSERT_COLUMNS.map(() => '?').join(', ')})`);
		expect(sql.match(/\(\?, \?/g)).toHaveLength(2);
	});

	test('rejects a non-positive row count', () => {
		expect(() => buildInsertSql(0)).toThrow(RangeError);
		expect(() => buildInsertSql(1.5)).toThrow(RangeError);
	});

	test('chunks stay under the driver placeholder budget', () => {
		expect(buildInsertSql(ARCHIVE_INSERT_CHUNK).match(/\(\?, \?/g)).toHaveLength(
			ARCHIVE_INSERT_CHUNK,
		);
	});
});

describe('toArchiveParams', () => {
	test('flattens events in column order with bigint timestamps', () => {
		const params = toArchiveParams(REGION, GROUP, [
			event({ streamName: 's-1', ingestionTime: TS + 5 }),
		]);
		expect(params).toEqual([
			REGION,
			GROUP,
			's-1',
			'evt-1',
			'evt-1',
			BigInt(TS),
			BigInt(TS + 5),
			'hello',
			null,
			null,
		]);
		expect(params).toHaveLength(ARCHIVE_INSERT_COLUMNS.length);
	});

	test('binds null for fields CloudWatch omits', () => {
		const params = toArchiveParams(REGION, GROUP, [event({ id: null, message: '' })]);
		expect(params[2]).toBeNull();
		expect(params[3]).toMatch(/^h:/);
		expect(params[4]).toBeNull();
		expect(params[6]).toBeNull();
		expect(params[8]).toBeNull();
		expect(params[9]).toBeNull();
	});

	test('flattens several events in one list', () => {
		const params = toArchiveParams(REGION, GROUP, [event(), event({ id: 'evt-2' })]);
		expect(params).toHaveLength(2 * ARCHIVE_INSERT_COLUMNS.length);
		expect(params[3]).toBe('evt-1');
		expect(params[ARCHIVE_INSERT_COLUMNS.length + 3]).toBe('evt-2');
	});
});

describe('escapeLike', () => {
	test('escapes wildcards and the escape character', () => {
		expect(escapeLike('100%_done')).toBe('100\\%\\_done');
		expect(escapeLike('back\\slash')).toBe('back\\\\slash');
		expect(escapeLike('plain')).toBe('plain');
	});
});

describe('buildPageQuery', () => {
	test('filters on region, group and window and ends with the limit', () => {
		const { sql, params } = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS + 1000,
			limit: 200,
		});
		expect(sql).toContain('WHERE region = ? AND log_group = ?');
		expect(sql).toContain('ORDER BY timestamp_ms, seq LIMIT ?');
		expect(sql).not.toContain('ILIKE');
		expect(params).toEqual([REGION, GROUP, BigInt(TS), BigInt(TS + 1000), BigInt(200)]);
	});

	test('adds the search term as an escaped substring match', () => {
		const { sql, params } = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS,
			search: '50% off',
			limit: 10,
		});
		expect(sql).toContain("message ILIKE ? ESCAPE '\\'");
		expect(params[4]).toBe('%50\\% off%');
	});

	test('ignores a blank search term', () => {
		const { sql } = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS,
			search: '   ',
			limit: 10,
		});
		expect(sql).not.toContain('ILIKE');
	});

	test('adds a stream prefix filter', () => {
		const { sql, params } = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS,
			streamPrefix: 'worker',
			limit: 10,
		});
		expect(sql).toContain("log_stream LIKE ? ESCAPE '\\'");
		expect(params[4]).toBe('worker%');
	});

	test('pages after a cursor with a tuple comparison', () => {
		const { sql, params } = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS + 10,
			after: { timestamp: TS + 3, seq: 42 },
			limit: 5,
		});
		expect(sql).toContain('(timestamp_ms > ? OR (timestamp_ms = ? AND seq > ?))');
		expect(params.slice(-4)).toEqual([BigInt(TS + 3), BigInt(TS + 3), BigInt(42), BigInt(5)]);
	});

	test('clamps a silly limit to a usable positive value', () => {
		const { params } = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS,
			limit: 0,
		});
		expect(params.at(-1)).toBe(BigInt(1));
	});
});

describe('rowsToPage', () => {
	test('maps rows, numbers and bigints alike, and reports the last cursor', () => {
		const page = rowsToPage([
			{
				timestamp_ms: BigInt(TS),
				seq: BigInt(7),
				message: 'first',
				log_stream: '/stream/one',
				event_key: 'evt-1',
				ingestion_time_ms: BigInt(TS + 1),
				level: 'error',
			},
			{ timestamp_ms: TS + 5, seq: 8, message: 'second', log_stream: null, event_key: null },
		]);
		expect(page.events).toEqual([
			{
				id: 'evt-1',
				timestamp: TS,
				message: 'first',
				streamName: '/stream/one',
				ingestionTime: TS + 1,
				level: 'error',
			},
			{ id: null, timestamp: TS + 5, message: 'second', level: null },
		]);
		expect(page.last).toEqual({ timestamp: TS + 5, seq: 8 });
	});

	test('filters by one or several levels', () => {
		const single = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS,
			levels: ['error'],
			limit: 10,
		});
		expect(single.sql).toContain('level IN (?)');
		expect(single.params).toContain('error');

		const many = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS,
			levels: ['error', 'warn'],
			limit: 10,
		});
		expect(many.sql).toContain('level IN (?, ?)');
		expect(many.params.slice(-3, -1)).toEqual(['error', 'warn']);
	});

	test('adds no level clause without a filter', () => {
		const { sql } = buildPageQuery({
			region: REGION,
			logGroup: GROUP,
			startTime: TS,
			endTime: TS,
			limit: 10,
		});
		expect(sql).not.toContain('level IN');
	});

	test('maps an unknown or missing stored level to null', () => {
		const page = rowsToPage([
			{ timestamp_ms: TS, seq: 1, message: 'junk level', level: 'shouty' },
			{ timestamp_ms: TS, seq: 2, message: 'no level' },
			{ timestamp_ms: TS, seq: 3, message: 'known', level: 'warn' },
		]);
		expect(page.events.map((entry) => entry.level)).toEqual([null, null, 'warn']);
	});

	test('skips rows without a usable timestamp or sequence', () => {
		const page = rowsToPage([
			{ timestamp_ms: null, seq: 1, message: 'no timestamp' },
			{ timestamp_ms: TS, seq: null, message: 'no seq' },
			{ timestamp_ms: TS, seq: 2, message: 'kept' },
		]);
		expect(page.events).toHaveLength(1);
		expect(page.last).toEqual({ timestamp: TS, seq: 2 });
	});

	test('returns an empty page for no rows', () => {
		expect(rowsToPage([])).toEqual({ events: [], last: null });
	});

	test('accepts upper-case column names', () => {
		const page = rowsToPage([{ TIMESTAMP_MS: TS, SEQ: 1, MESSAGE: 'up' }]);
		expect(page.events[0]?.message).toBe('up');
	});
});

describe('totals and groups', () => {
	test('maps the aggregate row', () => {
		expect(
			rowToTotals({ rows: BigInt(12), groups: BigInt(2), regions: 1, oldest: TS, newest: TS + 9 }),
		).toEqual({ rows: 12, groups: 2, regions: 1, oldest: TS, newest: TS + 9 });
	});

	test('reports an empty archive', () => {
		expect(rowToTotals(undefined)).toEqual({
			rows: 0,
			groups: 0,
			regions: 0,
			oldest: null,
			newest: null,
		});
		expect(rowToTotals({ rows: 0, groups: 0, regions: 0, oldest: null, newest: null }).rows).toBe(
			0,
		);
	});

	test('totals come from one aggregate query', () => {
		expect(ARCHIVE_TOTALS_SQL).toContain('FROM log_events');
		expect(ARCHIVE_TOTALS_SQL).toContain('min(timestamp_ms)');
	});

	test('groups query is unfiltered without a region', () => {
		const all = buildGroupsQuery(null);
		expect(all.sql).not.toContain('WHERE');
		expect(all.params).toEqual([]);
	});

	test('groups query filters by region', () => {
		const scoped = buildGroupsQuery(REGION);
		expect(scoped.sql).toContain('WHERE region = ?');
		expect(scoped.params).toEqual([REGION]);
	});

	test('maps group rows and drops unusable ones', () => {
		const groups = rowsToGroups([
			{ region: REGION, log_group: GROUP, events: BigInt(3), oldest: TS, newest: TS + 2 },
			{ region: null, log_group: GROUP, events: BigInt(1) },
			{ region: REGION, log_group: GROUP, events: '2', oldest: null, newest: null },
		]);
		expect(groups).toEqual([
			{ region: REGION, logGroup: GROUP, events: 3, oldest: TS, newest: TS + 2 },
			{ region: REGION, logGroup: GROUP, events: 2, oldest: null, newest: null },
		]);
	});
});
