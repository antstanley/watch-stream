#!/usr/bin/env node
/**
 * Launcher: run the SvelteKit dev server (or the production build) against a
 * chosen ambient AWS profile instead of the local floci emulator.
 *
 * Usage:
 *   node scripts/dev.ts --profile my-profile
 *   node scripts/dev.ts --profile my-profile --region eu-west-1 --port 5199
 *   node scripts/dev.ts --profile my-profile --start
 *   node scripts/dev.ts --list
 *   node scripts/dev.ts --profile my-profile --print
 *
 * `.env.local` (written by `pnpm floci:env`) keeps plain `pnpm dev` pointed at
 * floci. Environment variables win over dotenv files, so with `--profile` this
 * launcher blanks the local emulator settings for the child process only:
 * nothing is written to disk, `pnpm dev` keeps working unchanged, and a stray
 * `.env.local` cannot redirect a real-AWS run.
 *
 * The region needs a real value (see {@link REGION_KEYS}), so it comes from
 * `--region`, then from a region already exported in your shell, then from the
 * requested profile in `~/.aws/config`.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The graceful-shutdown bound is the CLI's, so both launchers stop the server the
// same way instead of keeping two copies of the same number.
import { SHUTDOWN_TIMEOUT_SECONDS } from '../src/cli/server.ts';
import {
	LOCAL_ENV_FILE,
	LOCAL_OVERRIDE_KEYS,
	REGION_KEYS,
	buildChildEnv,
	collectProfiles,
	describeChildEnv,
	isLocalEnvPresent,
	parsePort,
	profileFiles,
	readConfigText,
	readProfiles,
	readProfileRegion,
	resolveRunRegion,
	signalExitCode,
	type ChildEnvInput,
	type RegionInput,
} from '../src/lib/cli/aws.ts';

// The AWS/profile helpers live in `src/lib/cli/aws.ts` so the published CLI and
// this development launcher share one implementation. They are re-exported here
// because this file is their historical import surface.
export {
	LOCAL_ENV_FILE,
	LOCAL_OVERRIDE_KEYS,
	REGION_KEYS,
	buildChildEnv,
	collectProfiles,
	describeChildEnv,
	isLocalEnvPresent,
	parsePort,
	profileFiles,
	readConfigText,
	readProfiles,
	readProfileRegion,
	resolveRunRegion,
	signalExitCode,
};
export type { ChildEnvInput, RegionInput };

/** Repository root, resolved from this file so the working directory does not matter. */
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const VALUE_FLAGS = new Set(['--profile', '--region', '--port']);
/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(['--start', '--print', '--list', '--help']);

/** Options accepted on the command line. */
export type DevOptions = {
	/** `AWS_PROFILE` for the child process; `null` leaves the environment alone. */
	profile: string | null;
	/** `AWS_REGION`/`AWS_DEFAULT_REGION` for the child process. */
	region: string | null;
	/** Dev server port, or `PORT` for `--start`. */
	port: number | null;
	/** Run `node build/index.js` instead of `vite dev`. */
	start: boolean;
	/** Print the child's `AWS_*` environment and exit without starting anything. */
	print: boolean;
	/** Print the AWS profiles found in the shared config/credentials files and exit. */
	list: boolean;
	/** Print the usage text. */
	help: boolean;
};

/** Result of {@link parseArgs}: never throws, always reports a readable error. */
export type ParseResult = { ok: true; options: DevOptions } | { ok: false; error: string };

/**
 * Turns argv into options.
 *
 * Accepts `--flag value` and `--flag=value`, a bare positional profile name
 * (`pnpm dev:aws my-profile`) and a leading `--` that pnpm may insert. Unknown
 * flags and missing values come back as an error result, never as a throw, so
 * the caller can print the usage text and exit 2.
 */
export function parseArgs(argv: string[]): ParseResult {
	const options: DevOptions = {
		profile: null,
		region: null,
		port: null,
		start: false,
		print: false,
		list: false,
		help: false,
	};
	const tokens = argv[0] === '--' ? argv.slice(1) : argv;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === '--') continue;

		const separator = token.startsWith('--') ? token.indexOf('=') : -1;
		const name = separator > 0 ? token.slice(0, separator) : token;
		const inline = separator > 0 ? token.slice(separator + 1) : undefined;

		if (VALUE_FLAGS.has(name)) {
			let value = inline;
			if (value === undefined) {
				const next = tokens[index + 1];
				if (next === undefined || next.startsWith('--')) {
					return { ok: false, error: `Missing value for ${name}` };
				}
				value = next;
				index += 1;
			}
			if (name === '--port') {
				const port = parsePort(value);
				if (port === null) {
					return {
						ok: false,
						error: `Invalid value for --port: "${value}" (expected a port number from 1 to 65535)`,
					};
				}
				options.port = port;
				continue;
			}
			const trimmed = value.trim();
			if (trimmed.length === 0) return { ok: false, error: `Missing value for ${name}` };
			if (name === '--profile') options.profile = trimmed;
			else options.region = trimmed;
			continue;
		}

		if (BOOLEAN_FLAGS.has(name)) {
			if (inline !== undefined) return { ok: false, error: `${name} does not take a value` };
			if (name === '--start') options.start = true;
			else if (name === '--print') options.print = true;
			else if (name === '--list') options.list = true;
			else options.help = true;
			continue;
		}

		if (name.startsWith('-')) return { ok: false, error: `Unknown option "${name}"` };
		if (options.profile !== null) return { ok: false, error: `Unexpected argument "${token}"` };
		options.profile = token.trim();
		if (options.profile.length === 0) {
			return { ok: false, error: 'Missing value for --profile' };
		}
	}

	return { ok: true, options };
}

/** Usage text for `--help`. */
export function usageText(): string {
	return [
		'Usage: node scripts/dev.ts [options] [profile]',
		'',
		'Start the dev server (or the production build) against a chosen AWS profile.',
		'Without --profile nothing changes: plain `pnpm dev` keeps using .env.local.',
		'',
		'Options:',
		'  --profile <name>  set AWS_PROFILE for the server process',
		'  --region <code>   set AWS_REGION and AWS_DEFAULT_REGION for the server process',
		'  --port <n>        dev server port (vite dev --port n --strictPort), or PORT=n for --start',
		'  --start           run the production build (node build/index.js) instead of vite dev',
		'  --print           print the AWS_* environment for this run and exit (starts nothing)',
		'  --list            list the profiles in ~/.aws/config and ~/.aws/credentials and exit',
		'  --help            show this help',
		'',
		'With --profile the region is resolved like the app resolves it: --region, then',
		'AWS_REGION/AWS_DEFAULT_REGION already exported in your shell, then the profile',
		'region in ~/.aws/config. Local floci settings from .env.local are ignored.',
		'',
		'Examples:',
		'  pnpm dev:aws --profile my-profile',
		'  pnpm dev:aws --profile my-profile --region eu-west-1 --port 5199',
		'  pnpm dev:aws --start --profile my-profile',
		'  pnpm dev:aws --list',
		'  pnpm dev:aws --profile my-profile --print',
		'',
		'A leading `--` (which pnpm may insert) is tolerated, and a bare profile name',
		'works too: `pnpm dev:aws my-profile`.',
	].join('\n');
}

/** Writes a one-line note to stderr; stdout stays machine readable for --print/--list. */
function note(message: string): void {
	console.error(`dev: ${message}`);
}

/** Warns when the requested profile is in neither shared file. Never fails the run. */
function warnMissingProfile(profile: string): void {
	if (readProfiles().includes(profile)) return;
	note(`profile "${profile}" was not found in ~/.aws/config or ~/.aws/credentials.`);
	note('it may still resolve through an SSO session, credential_process or an instance role.');
	note('run `pnpm dev:aws --list` to see the profiles those files define.');
}

/** Options for {@link runChild}. */
type RunOptions = { start: boolean; port: number | null };

/** Development archive file, inside the repository and git-ignored. */
const DEV_ARCHIVE_FILE = join(rootDir, '.watch-tail', 'archive.duckdb');

/**
 * Starts the child with inherited stdio, forwards SIGINT/SIGTERM to it and
 * resolves with the exit code this launcher should use.
 */
function runChild(env: NodeJS.ProcessEnv, options: RunOptions): Promise<number> {
	const childEnv: NodeJS.ProcessEnv = { ...env };
	let command: string;
	let args: string[];

	if (options.start) {
		command = process.execPath;
		args = [join(rootDir, 'build', 'index.js')];
		if (options.port !== null) childEnv.PORT = String(options.port);
		// The app closes its own streams on a signal, so this is only the outer
		// bound: adapter-node's thirty-second default reads as a hung Ctrl+C.
		childEnv.SHUTDOWN_TIMEOUT = String(SHUTDOWN_TIMEOUT_SECONDS);
	} else {
		args = ['dev'];
		if (options.port !== null) args.push('--port', String(options.port), '--strictPort');
		const localVite = join(rootDir, 'node_modules', '.bin', 'vite');
		if (existsSync(localVite)) {
			command = localVite;
		} else {
			command = 'pnpm';
			args = ['exec', 'vite', ...args];
		}
	}

	const child = spawn(command, args, {
		cwd: rootDir,
		env: childEnv,
		shell: false,
		stdio: 'inherit',
	});

	return new Promise<number>((resolveExit) => {
		const forwarded = new Set<NodeJS.Signals>();
		const forward = (signal: NodeJS.Signals): void => {
			// A repeated signal means the child is stuck: stop it hard.
			child.kill(forwarded.has(signal) ? 'SIGKILL' : signal);
			forwarded.add(signal);
		};
		const detach = (): void => {
			process.off('SIGINT', forward);
			process.off('SIGTERM', forward);
		};

		process.on('SIGINT', forward);
		process.on('SIGTERM', forward);
		// Last resort: never leave a stray server process behind.
		process.on('exit', () => {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		});

		child.on('error', (error) => {
			detach();
			note(`could not start ${command}: ${error.message}`);
			resolveExit(127);
		});
		child.on('close', (code, signal) => {
			detach();
			resolveExit(code ?? signalExitCode(signal));
		});
	});
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed.ok) {
		note(parsed.error);
		console.error(usageText());
		process.exitCode = 2;
		return;
	}

	const { profile, region, port, start, print, list, help } = parsed.options;
	if (help) {
		console.log(usageText());
		return;
	}

	// A blank AWS_REGION is not "unset" for the SDK, so a profile run resolves a
	// real region first and only blanks the region keys when nothing is found.
	const childRegion =
		profile === null
			? region
			: resolveRunRegion({ region, profile, base: process.env, configText: readConfigText() });
	const env = buildChildEnv({ base: process.env, profile, region: childRegion });
	// Keep the history archive inside the repository during development, so
	// `pnpm dev` and `pnpm dev:aws` never write to the data directory of whoever
	// runs them. An explicit value in the environment still wins.
	env.WATCH_STREAM_ARCHIVE_DB ??= DEV_ARCHIVE_FILE;

	if (list) {
		const names = readProfiles();
		for (const name of names) console.log(name);
		if (names.length === 0) note('no profiles found in ~/.aws/config or ~/.aws/credentials.');
		return;
	}

	if (profile !== null) {
		warnMissingProfile(profile);
		if (childRegion === null) {
			note(`no region found for profile "${profile}"; pass --region <code> to set one.`);
		}
		if (isLocalEnvPresent()) {
			note(`.env.local exists; its local floci settings are ignored for this run (${profile}).`);
		}
	}

	if (print) {
		for (const line of describeChildEnv(env)) console.log(line);
		return;
	}

	const label = start ? 'the production build' : 'the dev server';
	if (profile === null) console.log(`dev: starting ${label}...`);
	else console.log(`dev: starting ${label} with AWS_PROFILE=${profile}...`);
	process.exitCode = await runChild(env, { start, port });
}

/** True when this file was started directly (`node scripts/dev.ts`), not imported by a test. */
function invokedDirectly(): boolean {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedDirectly()) {
	await main();
}
