#!/usr/bin/env node
/**
 * Seed the local floci AWS emulator with CloudWatch Logs fixtures:
 * a handful of log groups, streams and events. With `--watch` it keeps
 * appending new events so the UI has something to tail live.
 *
 * Usage:
 *   node scripts/seed-floci.ts                 # create groups + backfill events
 *   node scripts/seed-floci.ts --watch         # keep emitting events until Ctrl-C
 *   node scripts/seed-floci.ts --endpoint http://localhost:4566 --region eu-west-1
 *   node scripts/seed-floci.ts --reset         # delete the demo groups first
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CloudWatchLogsClient,
	CreateLogGroupCommand,
	CreateLogStreamCommand,
	DeleteLogGroupCommand,
	DescribeLogStreamsCommand,
	PutLogEventsCommand,
	type InputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';

/**
 * Load `.env.local` (written by `pnpm floci:env`) when it exists.
 * Node does not override environment variables that are already set.
 */
function loadLocalEnv(): void {
	const envFile = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env.local');
	if (existsSync(envFile)) process.loadEnvFile(envFile);
}

type Fixture = {
	group: string;
	streams: string[];
	retentionInDays?: number;
	/** Message templates; `{n}`/`{id}` are replaced per event. */
	templates: string[];
	/**
	 * A fixture whose lines belong to requests.
	 *
	 * A Lambda prints one invocation as `START RequestId: ...`, some body lines,
	 * then `END`/`REPORT` with the *same* id - so a fixture that wants to look like
	 * one gets the id and the burst shape, rather than a fresh id per line.
	 */
	requests?: {
		/** Line opening a request. */
		start: string;
		/** Body lines; two to four are drawn per request. */
		bodies: string[];
		/** Lines closing a request. */
		end: string[];
	};
};

const FIXTURES: Fixture[] = [
	{
		group: '/aws/lambda/checkout-api',
		retentionInDays: 14,
		streams: ['2026/01/01/[$LATEST]9f2c1a4b', '2026/01/02/[$LATEST]1a77b3de'],
		templates: [],
		// One invocation is one request, which is what the log view groups by.
		requests: {
			start: 'START RequestId: {id} Version: $LATEST',
			bodies: [
				'{"level":"info","requestId":"{id}","msg":"cart validated","items":{n},"durationMs":{n}}',
				'{"level":"info","requestId":"{id}","msg":"order accepted","order":{"id":"ord_{id}","total":{n},"currency":"ZAR","items":[{"sku":"SKU-{n}","qty":{n}},{"sku":"SKU-{n}","qty":1}]},"customer":{"id":"cus_{id}","tier":"gold"}}',
				'{"level":"warn","requestId":"{id}","msg":"payment retry","attempt":{n},"provider":"stripe"}',
				'{"level":"error","requestId":"{id}","msg":"checkout failed","reason":"card_declined","orderId":"ord_{n}"}',
			],
			end: [
				'END RequestId: {id}',
				'REPORT RequestId: {id}\tDuration: {n} ms\tBilled Duration: {n} ms\tMemory Size: 512 MB',
			],
		},
	},
	{
		group: '/aws/lambda/order-worker',
		retentionInDays: 7,
		streams: ['2026/01/01/[$LATEST]b41de900'],
		templates: [
			'{"level":"info","msg":"batch picked up","size":{n}}',
			'{"level":"debug","msg":"reserving stock","sku":"SKU-{n}"}',
			'{"level":"error","msg":"downstream timeout","target":"inventory","timeoutMs":{n}}',
			'Traceback (most recent call last):\n  File "/var/task/handler.py", line {n}, in process\n    raise TimeoutError("inventory")',
		],
	},
	{
		group: '/app/api/gateway',
		streams: ['gateway-a', 'gateway-b'],
		templates: [
			'GET /v1/orders 200 {n}ms',
			'POST /v1/checkout 201 {n}ms',
			'GET /v1/health 200 1ms',
			'WARN slow upstream /v1/catalog took {n}ms',
			'ERROR upstream 503 /v1/inventory after {n}ms',
		],
	},
	{
		group: '/app/worker/queue',
		streams: ['worker-0'],
		templates: [
			'picked job {id} from queue=orders',
			'job {id} finished in {n}ms',
			'retrying job {id} attempt={n}',
			'job {id} failed permanently: schema mismatch',
		],
	},
	{
		group: '/aws/rds/instance/orders/postgresql',
		retentionInDays: 3,
		streams: ['postgresql'],
		templates: [
			'LOG:  duration: {n} ms  statement: SELECT * FROM orders WHERE id = $1',
			'LOG:  checkpoint starting: time',
			'WARNING:  oldest xmin is far in the past',
		],
	},
];

type Options = {
	watch: boolean;
	reset: boolean;
	endpoint: string;
	region: string;
	intervalMs: number;
	backfill: number;
	backfillMinutes: number;
	allowRemote: boolean;
};

function parseArgs(argv: string[]): Options {
	const value = (flag: string, fallback: string): string => {
		const index = argv.indexOf(flag);
		return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
	};
	const env = process.env;
	return {
		watch: argv.includes('--watch'),
		reset: argv.includes('--reset'),
		endpoint: value('--endpoint', env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'),
		region: value('--region', env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1'),
		intervalMs: Number.parseInt(value('--interval', '1000'), 10),
		backfill: Number.parseInt(value('--backfill', '40'), 10),
		backfillMinutes: Number.parseInt(value('--backfill-minutes', '10'), 10),
		allowRemote: argv.includes('--allow-remote'),
	};
}

/** True for localhost-ish and known emulator hosts (floci, LocalStack). */
export function isLocalEndpoint(endpoint: string): boolean {
	try {
		const { hostname } = new URL(endpoint);
		return (
			hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '::1' ||
			hostname.endsWith('.localhost') ||
			hostname.includes('floci') ||
			hostname.includes('localstack')
		);
	} catch {
		return false;
	}
}

export function randomId(): string {
	return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);
}

/** Expand a fixture template into a concrete log message. */
export function renderMessage(template: string, seed: number, id = randomId()): string {
	return template.replaceAll('{id}', id).replaceAll('{n}', String(1 + Math.floor(seed % 997)));
}

function pick<T>(items: T[]): T {
	return items[Math.floor(Math.random() * items.length)];
}

async function createGroup(client: CloudWatchLogsClient, fixture: Fixture): Promise<void> {
	try {
		await client.send(
			new CreateLogGroupCommand({
				logGroupName: fixture.group,
				...(fixture.retentionInDays ? { retentionInDays: fixture.retentionInDays } : {}),
			}),
		);
	} catch (error) {
		if (!/AlreadyExists/i.test(String(error))) throw error;
	}
	for (const stream of fixture.streams) {
		try {
			await client.send(
				new CreateLogStreamCommand({ logGroupName: fixture.group, logStreamName: stream }),
			);
		} catch (error) {
			if (!/AlreadyExists/i.test(String(error))) throw error;
		}
	}
}

async function sequenceToken(
	client: CloudWatchLogsClient,
	group: string,
	stream: string,
): Promise<string | undefined> {
	try {
		const { logStreams } = await client.send(
			new DescribeLogStreamsCommand({
				logGroupName: group,
				logStreamNamePrefix: stream,
			}),
		);
		return logStreams?.find((entry) => entry.logStreamName === stream)?.uploadSequenceToken;
	} catch {
		return undefined;
	}
}

/** Put a batch of events, retrying once with the sequence token AWS expects. */
async function putEvents(
	client: CloudWatchLogsClient,
	group: string,
	stream: string,
	events: InputLogEvent[],
): Promise<void> {
	const token = await sequenceToken(client, group, stream);
	try {
		await client.send(
			new PutLogEventsCommand({
				logGroupName: group,
				logStreamName: stream,
				logEvents: events,
				...(token ? { sequenceToken: token } : {}),
			}),
		);
	} catch (error) {
		const expected = /expectedSequenceToken:\s*([\w-]+)/.exec(String(error))?.[1];
		if (!expected) throw error;
		await client.send(
			new PutLogEventsCommand({
				logGroupName: group,
				logStreamName: stream,
				logEvents: events,
				sequenceToken: expected,
			}),
		);
	}
}

/**
 * Lines of one request: its opening line, two to four body lines, and the lines
 * that close it. Every line carries the same id, spaced a few milliseconds apart,
 * which is what makes the request groupable and its span measurable.
 */
function requestEvents(
	fixture: Fixture,
	stream: string,
	index: number,
	startedAt: number,
): InputLogEvent[] {
	const shape = fixture.requests;
	if (shape === undefined) return [];
	const id = randomId();
	const seed = streamSeed(stream, index);
	const bodyCount = 2 + (seed % 3);
	const bodies = Array.from(
		{ length: bodyCount },
		(_, position) => shape.bodies[(seed + position) % shape.bodies.length] as string,
	);
	const lines = [shape.start, ...bodies, ...(seed % 4 === 0 ? [] : shape.end)];
	return lines.map((template, position) => ({
		timestamp: startedAt + position * 4,
		message: renderMessage(template, seed + position, id),
	}));
}

/** Small per-stream offset so two streams never render identical sample lines. */
function streamSeed(stream: string, index: number): number {
	let hash = 0;
	for (const char of stream) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
	return hash + index * 31;
}

async function backfill(client: CloudWatchLogsClient, options: Options): Promise<void> {
	const now = Date.now();
	const windowMs = options.backfillMinutes * 60_000;
	for (const fixture of FIXTURES) {
		for (const stream of fixture.streams) {
			const events: InputLogEvent[] = [];
			// A fixture with `requests` spreads the same number of *lines* over fewer
			// requests, so the demo data reads the way the log view groups it.
			const requests = fixture.requests === undefined ? 0 : Math.max(1, options.backfill / 5);
			const slots = fixture.requests === undefined ? options.backfill : Math.ceil(requests);
			for (let index = 0; index < slots; index += 1) {
				const offset = Math.floor((index / slots) * windowMs);
				const at = now - windowMs + offset;
				if (fixture.requests === undefined) {
					events.push({
						timestamp: at,
						message: renderMessage(pick(fixture.templates), streamSeed(stream, index)),
					});
					continue;
				}
				events.push(...requestEvents(fixture, stream, index, at));
			}
			await putEvents(client, fixture.group, stream, events);
		}
	}
	console.log(
		`Backfilled ${options.backfill} events per stream over the last ${options.backfillMinutes} minutes` +
			` (the Lambda groups hold ${options.backfill / 5} requests each).`,
	);
}

async function emitOnce(client: CloudWatchLogsClient): Promise<number> {
	let emitted = 0;
	for (const fixture of FIXTURES) {
		if (Math.random() > 0.6) continue;
		const stream = pick(fixture.streams);
		const count = 1 + Math.floor(Math.random() * 3);
		const events: InputLogEvent[] = [];
		for (let index = 0; index < count; index += 1) {
			events.push({
				timestamp: Date.now() + index,
				message: renderMessage(pick(fixture.templates), Date.now() + index),
			});
		}
		await putEvents(client, fixture.group, stream, events);
		emitted += events.length;
	}
	return emitted;
}

async function reset(client: CloudWatchLogsClient): Promise<void> {
	for (const fixture of FIXTURES) {
		try {
			await client.send(new DeleteLogGroupCommand({ logGroupName: fixture.group }));
			console.log(`Deleted ${fixture.group}`);
		} catch (error) {
			if (!/ResourceNotFound/i.test(String(error))) throw error;
		}
	}
}

async function main(): Promise<void> {
	loadLocalEnv();
	const options = parseArgs(process.argv.slice(2));
	if (!options.allowRemote && !isLocalEndpoint(options.endpoint)) {
		console.error(
			`Refusing to seed ${options.endpoint}: it is not a local emulator endpoint.\n` +
				'Pass --allow-remote if you really mean to write to that account.',
		);
		process.exitCode = 1;
		return;
	}

	const client = new CloudWatchLogsClient({
		region: options.region,
		endpoint: options.endpoint,
		credentials: {
			accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
		},
	});

	console.log(`Seeding ${options.endpoint} (region ${options.region})`);
	if (options.reset) await reset(client);
	for (const fixture of FIXTURES) {
		await createGroup(client, fixture);
		console.log(`  ready  ${fixture.group} (${fixture.streams.length} stream(s))`);
	}
	await backfill(client, options);

	if (!options.watch) {
		console.log(
			'\nDone. Start the app with `pnpm dev`, or keep events flowing with `pnpm seed:watch`.',
		);
		return;
	}

	console.log('\nWatching: emitting new events (Ctrl-C to stop)...');
	let total = 0;
	let ticks = 0;
	const timer = setInterval(
		() => {
			void emitOnce(client)
				.then((count) => {
					total += count;
					ticks += 1;
					if (ticks % 10 === 0) console.log(`  emitted ${total} events so far`);
					return count;
				})
				.catch((error: unknown) => {
					console.error(`emit failed: ${error instanceof Error ? error.message : String(error)}`);
					return 0;
				});
		},
		Math.max(250, options.intervalMs),
	);

	const stop = (): void => {
		clearInterval(timer);
		console.log(`\nStopped after emitting ${total} events.`);
		process.exit(0);
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seed-floci.ts');
if (invokedDirectly) {
	await main();
}
