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
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file so the working directory does not matter. */
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** Name of the git-ignored file with the local emulator settings. */
export const LOCAL_ENV_FILE = '.env.local';

/**
 * Variables that point a run at a local emulator or at static keys.
 *
 * A blank value behaves as "unset" everywhere: the SDK's endpoint override
 * ignores an empty string, and its environment credential provider skips blank
 * keys, so blanking is enough to hand the run back to the ambient profile.
 */
export const LOCAL_OVERRIDE_KEYS: readonly string[] = [
	'AWS_ENDPOINT_URL',
	'AWS_ENDPOINT_URL_LOGS',
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
];

/**
 * `.env.local` also pins `AWS_REGION=us-east-1`, and `readEnv()` merges
 * `process.env` last, so a `--profile` run would never reach the profile's own
 * region (see ARCHITECTURE.md region precedence).
 *
 * Unlike the endpoint and credential variables, a *blank* region is not "unset"
 * for the SDK: an empty `AWS_REGION` makes the region provider throw
 * (`Region not accepted: region="" is not a valid hostname component`). These
 * keys are therefore blanked only as a last resort; {@link resolveRunRegion}
 * fills in a real value whenever one can be found, and when none can be the app
 * reports its clear "no region configured" error instead of silently using
 * floci's region.
 */
export const REGION_KEYS: readonly string[] = ['AWS_REGION', 'AWS_DEFAULT_REGION'];

/** Flags that take a value. */
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

/** Parses a TCP port, or returns `null` when the value is not a usable port. */
export function parsePort(value: string): number | null {
	const trimmed = value.trim();
	if (!/^\d{1,5}$/.test(trimmed)) return null;
	const port = Number(trimmed);
	return port >= 1 && port <= 65535 ? port : null;
}

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

/** Inner text of every `[section]` header line, comments and blank lines skipped. */
function sectionHeaders(text: string): string[] {
	const headers: string[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
		const match = /^\[([^\]]+)\]$/.exec(line);
		if (match) headers.push(match[1].trim());
	}
	return headers;
}

/** Deterministic ordering that does not depend on the platform locale. */
function compareNames(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/**
 * Profile names defined by a shared config file and a credentials file.
 *
 * Section parsing is deliberately simple: `[profile NAME]` and `[default]` in
 * `~/.aws/config` (so `[sso-session x]` is ignored), `[NAME]` in
 * `~/.aws/credentials`. The result is de-duplicated, `default` first, then
 * sorted.
 */
export function collectProfiles(configText: string, credentialsText: string): string[] {
	const found = new Set<string>();

	for (const header of sectionHeaders(configText)) {
		const named = /^profile\s+(.+)$/.exec(header);
		if (named !== null) found.add(named[1].trim());
		else if (header === 'default') found.add('default');
	}
	for (const header of sectionHeaders(credentialsText)) {
		if (header.length > 0) found.add(header);
	}

	const rest = [...found]
		.filter((name) => name !== 'default' && name.length > 0)
		.toSorted(compareNames);
	return found.has('default') ? ['default', ...rest] : rest;
}

/** Reads a text file, returning an empty string when it is missing or unreadable. */
function readTextFile(path: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}

/** Shared config and credentials file paths, honoring the standard overrides. */
export function profileFiles(env: NodeJS.ProcessEnv = process.env): {
	configFile: string;
	credentialsFile: string;
} {
	const config = env.AWS_CONFIG_FILE?.trim();
	const credentials = env.AWS_SHARED_CREDENTIALS_FILE?.trim();
	return {
		configFile:
			config !== undefined && config.length > 0 ? config : join(homedir(), '.aws', 'config'),
		credentialsFile:
			credentials !== undefined && credentials.length > 0
				? credentials
				: join(homedir(), '.aws', 'credentials'),
	};
}

/** Profile names found in the AWS shared config and credentials files. */
export function readProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
	const { configFile, credentialsFile } = profileFiles(env);
	return collectProfiles(readTextFile(configFile), readTextFile(credentialsFile));
}

/**
 * `region = ...` of one profile section in `~/.aws/config`, or `null` when that
 * section is missing or has no region.
 */
export function readProfileRegion(configText: string, profile: string): string | null {
	const wanted = new Set(
		profile === 'default' ? ['default', 'profile default'] : [`profile ${profile}`],
	);
	let section: string | null = null;

	for (const raw of configText.split('\n')) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;

		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header !== null) {
			section = header[1].trim();
			continue;
		}
		if (section === null || !wanted.has(section)) continue;

		const pair = /^region\s*=\s*(.*)$/.exec(line);
		if (pair === null) continue;
		const value = pair[1].replace(/\s[#;].*$/, '').trim();
		if (value.length > 0) return value;
	}

	return null;
}

/** Trims a value and treats blank strings as absent. */
function normalize(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Input for {@link resolveRunRegion}. */
export type RegionInput = {
	/** `--region` value; wins over everything else. */
	region?: string | null;
	/** Requested profile: its shared-config region is the last resort. */
	profile?: string | null;
	/** Caller's environment: a region already exported there beats the profile. */
	base: NodeJS.ProcessEnv;
	/** Text of `~/.aws/config`, read by the caller. */
	configText: string;
};

/**
 * Region to hand to the child, mirroring the app's documented precedence:
 * `--region`, then `AWS_REGION`/`AWS_DEFAULT_REGION` exported in the shell, then
 * the region of the requested profile in `~/.aws/config`.
 *
 * Returns `null` when nothing can be resolved. The caller then blanks the region
 * keys, and the app answers with "No AWS region is configured..." instead of
 * silently keeping the region that `.env.local` pins for floci.
 */
export function resolveRunRegion({
	region = null,
	profile = null,
	base,
	configText,
}: RegionInput): string | null {
	const explicit = normalize(region);
	if (explicit !== null) return explicit;

	const exported = normalize(base.AWS_REGION) ?? normalize(base.AWS_DEFAULT_REGION);
	if (exported !== null) return exported;

	const name = normalize(profile);
	if (name === null) return null;
	return readProfileRegion(configText, name);
}

/** Input for {@link buildChildEnv}. */
export type ChildEnvInput = {
	/** Environment to start from; it is copied, never mutated. */
	base: NodeJS.ProcessEnv;
	profile?: string | null;
	region?: string | null;
};

/**
 * Builds the environment for the child process.
 *
 * Without `profile` the base environment is returned unchanged, so plain
 * `pnpm dev` behaves exactly as before. With `profile` the local emulator
 * settings (endpoint, static keys and the pinned region) are blanked and
 * `AWS_PROFILE` is set, so the SDK resolves credentials and region from that
 * profile; a non-blank `region` is then applied as `AWS_REGION` and
 * `AWS_DEFAULT_REGION`, which is how `--region` (or a region resolved by
 * {@link resolveRunRegion}) wins over the profile.
 */
export function buildChildEnv({
	base,
	profile = null,
	region = null,
}: ChildEnvInput): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	const name = normalize(profile);

	if (name !== null) {
		env.AWS_PROFILE = name;
		for (const key of [...LOCAL_OVERRIDE_KEYS, ...REGION_KEYS]) env[key] = '';
	}

	const code = normalize(region);
	if (code !== null) {
		env.AWS_REGION = code;
		env.AWS_DEFAULT_REGION = code;
	}

	return env;
}

/**
 * `AWS_*` entries of a child environment as `KEY=value` lines, sorted by name.
 *
 * Blank values are kept: seeing `AWS_ENDPOINT_URL=` is how you confirm that the
 * local emulator settings were neutralized for this run.
 */
export function describeChildEnv(env: NodeJS.ProcessEnv): string[] {
	return Object.keys(env)
		.filter((key) => key.startsWith('AWS_'))
		.toSorted(compareNames)
		.map((key) => `${key}=${env[key] ?? ''}`);
}

/** True when `.env.local` (the floci settings) exists in the repository root. */
export function isLocalEnvPresent(cwd: string = rootDir): boolean {
	return existsSync(join(cwd, LOCAL_ENV_FILE));
}

/** Exit code for a child killed by a signal, following the shell convention. */
export function signalExitCode(signal: NodeJS.Signals | null): number {
	switch (signal) {
		case 'SIGINT':
			return 130;
		case 'SIGQUIT':
			return 131;
		case 'SIGTERM':
			return 143;
		case 'SIGHUP':
			return 129;
		default:
			return 1;
	}
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

/** Text of the AWS shared config file, or an empty string when it is missing. */
function readConfigText(env: NodeJS.ProcessEnv = process.env): string {
	return readTextFile(profileFiles(env).configFile);
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
