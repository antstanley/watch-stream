/**
 * AWS profile, region and child-environment helpers shared by the `watch-tail`
 * CLI and the development launcher (`scripts/dev.ts`).
 *
 * Everything here is pure apart from reading `~/.aws/config` and
 * `~/.aws/credentials`, so it can be unit tested without spawning anything and
 * reused by both entry points.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** Parses a TCP port, or returns `null` when the value is not a usable port. */
export function parsePort(value: string): number | null {
	const trimmed = value.trim();
	if (!/^\d{1,5}$/.test(trimmed)) return null;
	const port = Number(trimmed);
	return port >= 1 && port <= 65535 ? port : null;
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
	/**
	 * Emulator endpoint (floci, LocalStack). When set, the run targets that
	 * endpoint with throwaway credentials unless the environment already
	 * carries real keys.
	 */
	endpoint?: string | null;
	/**
	 * Blank just `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.
	 *
	 * Used when the profile comes from `AWS_PROFILE` in the environment rather
	 * than from `--profile`: a stray static key pair (a `.env.local`, a stale
	 * export) would otherwise make the SDK warn about conflicting sources, and
	 * the user's chosen profile is what they meant.
	 */
	clearStaticKeys?: boolean;
};

/** Throwaway credentials local emulators accept; floci never checks them. */
const EMULATOR_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' } as const;

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
	endpoint = null,
	clearStaticKeys = false,
}: ChildEnvInput): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	const name = normalize(profile);
	const emulator = normalize(endpoint);

	if (name !== null) {
		env.AWS_PROFILE = name;
		for (const key of [...LOCAL_OVERRIDE_KEYS, ...REGION_KEYS]) env[key] = '';
	}

	if (name === null && clearStaticKeys) {
		env.AWS_ACCESS_KEY_ID = '';
		env.AWS_SECRET_ACCESS_KEY = '';
	}

	if (emulator !== null) {
		env.AWS_ENDPOINT_URL = emulator;
		env.AWS_ENDPOINT_URL_LOGS = emulator;
		// Local emulators accept any non-empty key pair. Never override keys the
		// caller already configured: they may be signing for something real.
		if (normalize(base.AWS_ACCESS_KEY_ID) === null) {
			env.AWS_ACCESS_KEY_ID = EMULATOR_CREDENTIALS.accessKeyId;
			env.AWS_SECRET_ACCESS_KEY = EMULATOR_CREDENTIALS.secretAccessKey;
		}
	}

	const code = normalize(region);
	if (code !== null) {
		env.AWS_REGION = code;
		env.AWS_DEFAULT_REGION = code;
	}

	return env;
}

/** True when the endpoint points at a local emulator rather than real AWS. */
export function isEmulatorEndpoint(endpoint: string): boolean {
	let hostname = '';
	try {
		hostname = new URL(endpoint).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname.endsWith('.localhost') ||
		hostname.includes('floci') ||
		hostname.includes('localstack')
	);
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

/** Reads the shared AWS config file, or an empty string when it is missing. */
export function readConfigText(env: NodeJS.ProcessEnv = process.env): string {
	return readTextFile(profileFiles(env).configFile);
}

/** Reads the shared credentials file, or an empty string when it is missing. */
export function readCredentialsText(env: NodeJS.ProcessEnv = process.env): string {
	return readTextFile(profileFiles(env).credentialsFile);
}

/** True when `.env.local` (the floci settings) exists in the repository root. */
export function isLocalEnvPresent(cwd: string = process.cwd()): boolean {
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
