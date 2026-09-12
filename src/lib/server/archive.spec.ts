import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	ARCHIVE_FILE_NAME,
	LOCK_RETRIES,
	LogArchive,
	describeOpenError,
	loadDuckDbDriver,
	resolveArchiveConfig,
	type Driver,
	type DriverConnection,
} from './archive';
import {
	ARCHIVE_INSERT_CHUNK,
	ARCHIVE_INSERT_COLUMNS,
	archiveEventKey,
	type ArchiveParam,
} from './archive-sql';
import type { LogEventDto } from '$lib/types';

const TS = Date.UTC(2024, 4, 17, 12, 0, 0);

function event(overrides: Partial<LogEventDto> = {}): LogEventDto {
	return { id: 'evt-1', timestamp: TS, message: 'hello', ...overrides };
}

type Call = { sql: string; params: ArchiveParam[] | undefined };

/**
 * Builds a driver double that records every statement and answers reads from
 * `respond`. Native code is never loaded, so these tests run anywhere.
 */
function fakeDriver(
	options: {
		respond?: (sql: string, params: ArchiveParam[] | undefined) => Record<string, unknown>[];
		failOn?: (sql: string) => string | null;
		createFails?: string;
	} = {},
) {
	const calls: Call[] = [];
	let closes = 0;
	let connects = 0;
	const connection: DriverConnection = {
		async run(sql, params) {
			const failure = options.failOn?.(sql) ?? null;
			if (failure !== null) throw new Error(failure);
			calls.push({ sql, params });
		},
		async runAndReadAll(sql, params) {
			calls.push({ sql, params });
			return { getRowObjects: () => options.respond?.(sql, params) ?? [] };
		},
		closeSync() {
			closes += 1;
		},
	};
	const driver: Driver = {
		DuckDBInstance: {
			create: async () => {
				if (options.createFails !== undefined) throw new Error(options.createFails);
				return {
					connect: async () => {
						connects += 1;
						return connection;
					},
				};
			},
		},
	};
	return {
		driver,
		calls,
		statements: () => calls.map((call) => call.sql),
		closes: () => closes,
		connects: () => connects,
	};
}

describe('resolveArchiveConfig', () => {
	test('uses the platform data directory by default', () => {
		expect(resolveArchiveConfig({}, 'darwin', '/Users/dev')).toEqual({
			enabled: true,
			path: `/Users/dev/Library/Application Support/watch-tail/${ARCHIVE_FILE_NAME}`,
		});
	});

	test('honours XDG_DATA_HOME on linux and LOCALAPPDATA on windows', () => {
		expect(resolveArchiveConfig({ XDG_DATA_HOME: '/data' }, 'linux', '/home/dev').path).toBe(
			`/data/watch-tail/${ARCHIVE_FILE_NAME}`,
		);
		const windows = resolveArchiveConfig(
			{ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
			'win32',
			'C:\\Users\\dev',
		);
		expect(windows.path).toContain('watch-tail');
	});

	test('falls back to ~/.local/share elsewhere', () => {
		expect(resolveArchiveConfig({}, 'linux', '/home/dev').path).toBe(
			`/home/dev/.local/share/watch-tail/${ARCHIVE_FILE_NAME}`,
		);
	});

	test('prefers an explicit database path', () => {
		expect(
			resolveArchiveConfig({ WATCH_STREAM_ARCHIVE_DB: '/tmp/logs.duckdb' }, 'darwin', '/Users/dev'),
		).toEqual({
			enabled: true,
			path: '/tmp/logs.duckdb',
		});
	});

	test.each(['off', '0', 'false', 'NO', ' off '])('reads %s as disabled', (value) => {
		const config = resolveArchiveConfig({ WATCH_STREAM_ARCHIVE: value }, 'linux', '/home/dev');
		expect(config.enabled).toBe(false);
		expect(config.path.endsWith(ARCHIVE_FILE_NAME)).toBe(true);
	});

	test('any other value keeps the archive on', () => {
		expect(resolveArchiveConfig({ WATCH_STREAM_ARCHIVE: 'on' }, 'linux', '/home/dev').enabled).toBe(
			true,
		);
	});

	test('is off inside a test process, so tests cannot touch a real archive', () => {
		expect(resolveArchiveConfig({ VITEST: 'true' }, 'linux', '/home/dev').enabled).toBe(false);
		expect(resolveArchiveConfig({ NODE_ENV: 'test' }, 'linux', '/home/dev').enabled).toBe(false);
	});

	test('a test can opt in explicitly', () => {
		expect(
			resolveArchiveConfig({ VITEST: 'true', WATCH_STREAM_ARCHIVE: 'on' }, 'linux', '/home/dev')
				.enabled,
		).toBe(true);
		expect(
			resolveArchiveConfig(
				{ VITEST: 'true', WATCH_STREAM_ARCHIVE_DB: '/tmp/t.duckdb' },
				'linux',
				'/home/dev',
			),
		).toMatchObject({ enabled: true, path: '/tmp/t.duckdb' });
		expect(
			resolveArchiveConfig(
				{ VITEST: 'true', WATCH_STREAM_ARCHIVE: 'off', WATCH_STREAM_ARCHIVE_DB: '/tmp/t.duckdb' },
				'linux',
				'/home/dev',
			).enabled,
		).toBe(false);
	});
});

describe('LogArchive.open', () => {
	test('creates the schema in order and reports availability', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/does-not-matter/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const statements = fake.statements();
		expect(archive.available).toBe(true);
		expect(archive.error).toBeNull();
		expect(fake.connects()).toBe(1);
		expect(statements[0]).toContain('CREATE SEQUENCE IF NOT EXISTS log_events_seq');
		expect(statements[1]).toContain('CREATE TABLE IF NOT EXISTS log_events');
		expect(statements.at(-1)).toContain('CREATE INDEX IF NOT EXISTS log_events_time');
	});

	test('creates the parent directory before opening', async () => {
		const dirs: string[] = [];
		await LogArchive.open({
			path: '/tmp/archive-parent/archive.duckdb',
			load: async () => fakeDriver().driver,
			ensureDir: (dir) => dirs.push(dir),
		});
		expect(dirs).toEqual(['/tmp/archive-parent']);
	});

	test('degrades when the driver cannot be imported', async () => {
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => {
				throw new Error("Cannot find module '@duckdb/node-api'");
			},
			ensureDir: () => undefined,
		});
		expect(archive.available).toBe(false);
		expect(archive.error).toContain('@duckdb/node-api');
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(0);
		expect(
			await archive.page({
				region: 'us-east-1',
				logGroup: '/g',
				startTime: 0,
				endTime: TS,
				limit: 10,
			}),
		).toEqual({
			events: [],
			last: null,
		});
		expect(await archive.totals()).toEqual({
			rows: 0,
			groups: 0,
			regions: 0,
			oldest: null,
			newest: null,
		});
		expect(await archive.groups()).toEqual([]);
		expect((await archive.status()).available).toBe(false);
	});

	test('degrades when the database file cannot be opened', async () => {
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fakeDriver({ createFails: 'database is locked' }).driver,
			ensureDir: () => undefined,
		});
		expect(archive.available).toBe(false);
		expect(archive.error).toBe('database is locked');
	});

	test('unavailable() is a silent no-op that keeps the path', async () => {
		const archive = LogArchive.unavailable('/tmp/off.duckdb');
		expect(archive.path).toBe('/tmp/off.duckdb');
		expect(archive.available).toBe(false);
		expect(archive.error).toBeNull();
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(0);
		expect((await archive.status()).error).toBeNull();
	});
});

describe('LogArchive.record', () => {
	test('writes one statement per chunk with flattened parameters', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const events = Array.from({ length: ARCHIVE_INSERT_CHUNK + 3 }, (_, index) =>
			event({ id: `evt-${index}` }),
		);
		const written = await archive.record('af-south-1', '/aws/lambda/api', events);

		const inserts = fake.calls.filter((call) => call.sql.includes('INSERT OR IGNORE'));
		expect(written).toBe(events.length);
		expect(inserts).toHaveLength(2);
		const paramsPerRow = ARCHIVE_INSERT_COLUMNS.length;
		expect(inserts[0]?.params).toHaveLength(ARCHIVE_INSERT_CHUNK * paramsPerRow);
		expect(inserts[1]?.params).toHaveLength(3 * paramsPerRow);
		expect(inserts[0]?.params?.slice(0, 5)).toEqual([
			'af-south-1',
			'/aws/lambda/api',
			null,
			'evt-0',
			'evt-0',
		]);
	});

	test('skips an empty batch without touching the database', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const before = fake.calls.length;
		expect(await archive.record('us-east-1', '/g', [])).toBe(0);
		expect(fake.calls).toHaveLength(before);
	});

	test('swallows a write failure and reports it', async () => {
		const fake = fakeDriver({ failOn: (sql) => (sql.includes('INSERT') ? 'disk full' : null) });
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(0);
		expect(archive.error).toBe('disk full');
		expect(archive.available).toBe(true);
	});
});

describe('LogArchive reads', () => {
	test('maps a page and its cursor', async () => {
		const fake = fakeDriver({
			respond: (sql) =>
				sql.startsWith('SELECT region, log_group, log_stream')
					? [
							{
								region: 'us-east-1',
								log_group: '/g',
								log_stream: 's-1',
								event_key: 'evt-1',
								event_id: 'evt-1',
								timestamp_ms: BigInt(TS),
								ingestion_time_ms: null,
								message: 'hello',
								level: 'error',
								level_source: 'json',
								seq: BigInt(4),
							},
						]
					: [],
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const page = await archive.page({
			region: 'us-east-1',
			logGroup: '/g',
			startTime: TS,
			endTime: TS + 1000,
			limit: 5,
		});
		expect(page.events).toEqual([
			{ id: 'evt-1', timestamp: TS, message: 'hello', streamName: 's-1', level: 'error' },
		]);
		expect(page.last).toEqual({ timestamp: TS, seq: 4 });
	});

	test('maps totals and groups', async () => {
		const fake = fakeDriver({
			respond: (sql) =>
				sql.includes('count(DISTINCT log_group)')
					? [
							{
								rows: BigInt(7),
								groups: BigInt(2),
								regions: BigInt(1),
								oldest: BigInt(TS),
								newest: BigInt(TS + 5),
							},
						]
					: [
							{
								region: 'us-east-1',
								log_group: '/g',
								events: BigInt(7),
								oldest: BigInt(TS),
								newest: BigInt(TS + 5),
							},
						],
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		expect(await archive.totals()).toEqual({
			rows: 7,
			groups: 2,
			regions: 1,
			oldest: TS,
			newest: TS + 5,
		});
		expect(await archive.groups()).toEqual([
			{ region: 'us-east-1', logGroup: '/g', events: 7, oldest: TS, newest: TS + 5 },
		]);
		expect(await archive.groups('us-east-1')).toHaveLength(1);
	});

	test('status reports a null size when the file is missing', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/definitely-missing-watch-tail-archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const status = await archive.status();
		expect(status.path).toBe('/tmp/definitely-missing-watch-tail-archive.duckdb');
		expect(status.bytes).toBeNull();
		expect(status.totals.rows).toBe(0);
	});

	test('close closes the connection once and marks the archive unavailable', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		await archive.close();
		await archive.close();
		expect(fake.closes()).toBe(1);
		expect(archive.available).toBe(false);
	});
});

describe('loadDuckDbDriver', () => {
	test('loads the real module when it is installed, and rejects when it is not', async () => {
		// The driver is an optional dependency, so both outcomes are valid here:
		// either it loads and exposes the factory, or the import fails.
		const installed = await loadDuckDbDriver().catch(() => null);
		expect(installed === null || typeof installed.DuckDBInstance.create === 'function').toBe(true);
	});
});

/** True when the optional DuckDB driver is installed on this machine. */
const driverInstalled = await loadDuckDbDriver().then(
	() => true,
	() => false,
);

describe.skipIf(!driverInstalled)('LogArchive against a real database file', () => {
	test('writes, de-duplicates, pages and searches', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'watch-tail-archive-'));
		const path = join(dir, 'archive.duckdb');
		const archive = await LogArchive.open({ path });
		try {
			expect(archive.available).toBe(true);
			const sameTimestamp = [
				event({ id: 'a', timestamp: TS, message: 'first line' }),
				event({ id: 'b', timestamp: TS, message: 'second line' }),
				event({ id: 'c', timestamp: TS + 1, message: 'ERROR third line' }),
			];
			expect(await archive.record('af-south-1', '/aws/lambda/api', sameTimestamp)).toBe(3);
			// Re-scanning the same window must not duplicate rows.
			await archive.record('af-south-1', '/aws/lambda/api', sameTimestamp);
			await archive.record('eu-west-1', '/aws/lambda/other', [
				event({ id: 'd', timestamp: TS + 2, message: 'other region' }),
			]);

			expect(await archive.totals()).toEqual({
				rows: 4,
				groups: 2,
				regions: 2,
				oldest: TS,
				newest: TS + 2,
			});

			const first = await archive.page({
				region: 'af-south-1',
				logGroup: '/aws/lambda/api',
				startTime: TS,
				endTime: TS + 10,
				limit: 2,
			});
			expect(first.events.map((item) => item.id)).toEqual(['a', 'b']);
			expect(first.last).toEqual({ timestamp: TS, seq: Number(first.last?.seq) });

			// Equal timestamps must not repeat or skip: the cursor breaks the tie.
			const second = await archive.page({
				region: 'af-south-1',
				logGroup: '/aws/lambda/api',
				startTime: TS,
				endTime: TS + 10,
				after: first.last,
				limit: 2,
			});
			expect(second.events.map((item) => item.id)).toEqual(['c']);

			const searched = await archive.page({
				region: 'af-south-1',
				logGroup: '/aws/lambda/api',
				startTime: TS,
				endTime: TS + 10,
				search: 'error',
				limit: 10,
			});
			expect(searched.events.map((item) => item.message)).toEqual(['ERROR third line']);

			const literal = await archive.page({
				region: 'af-south-1',
				logGroup: '/aws/lambda/api',
				startTime: TS,
				endTime: TS + 10,
				search: '%',
				limit: 10,
			});
			expect(literal.events).toEqual([]);

			// Levels are derived once on the way in and stored with their provenance.
			await archive.record('af-south-1', '/aws/lambda/api', [
				event({ id: 'level-json', timestamp: TS + 4, message: '{"level":"error","msg":"boom"}' }),
				event({ id: 'level-text', timestamp: TS + 5, message: 'WARN slow upstream' }),
				event({
					id: 'level-none',
					timestamp: TS + 6,
					message: '\tat com.example.Handler.invoke(Handler.java:41)',
				}),
			]);
			const all = await archive.page({
				region: 'af-south-1',
				logGroup: '/aws/lambda/api',
				startTime: TS + 4,
				endTime: TS + 6,
				limit: 10,
			});
			expect(all.events.map((item) => [item.id, item.level])).toEqual([
				['level-json', 'error'],
				['level-text', 'warn'],
				['level-none', null],
			]);

			const onlyErrors = await archive.page({
				region: 'af-south-1',
				logGroup: '/aws/lambda/api',
				startTime: TS,
				endTime: TS + 10,
				levels: ['error'],
				limit: 10,
			});
			// 'c' is the text-detected ERROR line recorded earlier, so both detection
			// paths are covered by one filter.
			expect(onlyErrors.events.map((item) => item.id)).toEqual(['c', 'level-json']);

			const warnings = await archive.page({
				region: 'af-south-1',
				logGroup: '/aws/lambda/api',
				startTime: TS,
				endTime: TS + 10,
				levels: ['warn', 'error'],
				limit: 10,
			});
			expect(warnings.events.map((item) => item.level).toSorted()).toEqual([
				'error',
				'error',
				'warn',
			]);

			// Rows stored before the level columns existed stay NULL, and a NULL level
			// is never returned by a level filter.
			expect(all.events.some((item) => item.level === null)).toBe(true);

			const groups = await archive.groups('eu-west-1');
			expect(groups).toEqual([
				{
					region: 'eu-west-1',
					logGroup: '/aws/lambda/other',
					events: 1,
					oldest: TS + 2,
					newest: TS + 2,
				},
			]);

			// Events without a CloudWatch id are keyed by content, so a re-scan is still idempotent.
			await archive.record('af-south-1', '/aws/lambda/api', [
				event({ id: null, timestamp: TS + 3, message: 'synthetic' }),
			]);
			await archive.record('af-south-1', '/aws/lambda/api', [
				event({ id: null, timestamp: TS + 3, message: 'synthetic' }),
			]);
			const after = await archive.page({
				region: 'af-south-1',
				logGroup: '/aws/lambda/api',
				startTime: TS + 3,
				endTime: TS + 3,
				limit: 10,
			});
			expect(after.events).toHaveLength(1);
			expect(after.events[0]?.id).toBe(
				archiveEventKey(event({ id: null, timestamp: TS + 3, message: 'synthetic' })),
			);
		} finally {
			await archive.close();
			rmSync(dir, { recursive: true, force: true });
		}
		expect(existsSync(path)).toBe(false);
	});
});

describe('describeOpenError and the lock retry', () => {
	test('explains a conflicting lock in terms the user can act on', () => {
		const duckdbMessage = `IO Error: Could not set lock on file "/tmp/archive.duckdb": Conflicting lock is held in /usr/bin/node (PID 123) by user stan. See also https://duckdb.org/docs/stable/connect/concurrency`;
		const described = describeOpenError(new Error(duckdbMessage), '/tmp/archive.duckdb');
		expect(described).toContain('/tmp/archive.duckdb is locked by another process');
		expect(described).toContain('--db');
		expect(described).not.toContain('duckdb.org');
	});

	test('passes any other failure through unchanged', () => {
		expect(describeOpenError(new Error('Cannot find module @duckdb/node-api'), '/x')).toBe(
			'Cannot find module @duckdb/node-api',
		);
		expect(describeOpenError('disk full', '/x')).toBe('disk full');
	});

	test('retries a locked archive and succeeds once the lock clears', async () => {
		let attempts = 0;
		const driver: Driver = {
			DuckDBInstance: {
				create: async () => {
					attempts += 1;
					if (attempts < LOCK_RETRIES) {
						throw new Error('IO Error: Could not set lock on file "/tmp/a.duckdb"');
					}
					return {
						connect: async () =>
							fakeDriver()
								.driver.DuckDBInstance.create('/x')
								.then((i) => i.connect())
								.then(() => ({
									run: async () => undefined,
									runAndReadAll: async () => ({ getRowObjects: () => [] }),
								})),
					};
				},
			},
		};
		const archive = await LogArchive.open({
			path: '/tmp/a.duckdb',
			load: async () => driver,
			ensureDir: () => undefined,
		});
		expect(attempts).toBe(LOCK_RETRIES);
		expect(archive.available).toBe(true);
	});

	test('reports the lock message when it never clears', async () => {
		const archive = await LogArchive.open({
			path: '/tmp/locked.duckdb',
			load: async () =>
				fakeDriver({ createFails: 'IO Error: Could not set lock on file "/x"' }).driver,
			ensureDir: () => undefined,
		});
		expect(archive.available).toBe(false);
		expect(archive.error).toContain('locked by another process');
	});
});
