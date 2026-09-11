/**
 * Shell completions, powered by `@bomb.sh/tab`.
 *
 * `watch-tail complete <shell>` prints the script to source, and
 * `watch-tail complete -- <words>` answers the protocol that script drives. Both
 * paths are dispatched before normal flag parsing.
 */
import t from '@bomb.sh/tab';
import { readProfiles } from '../lib/cli/aws.ts';
import { DEFAULT_HOST, DEFAULT_PORT, FLOCI_ENDPOINT } from './options.ts';

/** Shells `tab` can generate scripts for. */
export const SHELLS = ['zsh', 'bash', 'fish', 'powershell'] as const;

/** Program name used in generated completion scripts. */
export const PROGRAM = 'watch-tail';

/** Regions offered for `--region`; the long tail lives in `$lib/regions.ts`. */
const COMMON_REGIONS = [
	'us-east-1',
	'us-east-2',
	'us-west-1',
	'us-west-2',
	'eu-west-1',
	'eu-west-2',
	'eu-central-1',
	'ap-south-1',
	'ap-southeast-1',
	'ap-southeast-2',
	'ap-northeast-1',
	'af-south-1',
	'sa-east-1',
];

/**
 * Declares the CLI structure for `tab`.
 *
 * Safe to call repeatedly: `tab` merges commands and options into one root.
 */
function registerCompletionSpec(profiles: string[] = []): void {
	t.option(
		'profile',
		'AWS profile to use',
		function (complete) {
			if (profiles.length === 0) complete('default', 'default profile');
			for (const name of profiles) complete(name, 'AWS profile');
		},
		'p',
	);
	t.option(
		'region',
		'Region to open on',
		function (complete) {
			for (const region of COMMON_REGIONS) complete(region, 'AWS region');
		},
		'r',
	);
	t.option('endpoint', 'Emulator endpoint instead of AWS', function (complete) {
		complete(FLOCI_ENDPOINT, 'floci');
		complete('http://localhost:4566', 'LocalStack');
	});
	t.option('floci', 'Shorthand for --endpoint ' + FLOCI_ENDPOINT);
	t.option('port', 'Port for the local UI', function (complete) {
		complete(String(DEFAULT_PORT), 'default');
		complete('5173', 'Vite default');
	});
	t.option('host', 'Interface to bind', function (complete) {
		complete(DEFAULT_HOST, 'loopback only');
		complete('0.0.0.0', 'all interfaces (exposes your AWS access)');
	});
	t.option('open', 'Open a browser window (default)');
	t.option('no-open', 'Do not open a browser window');
	t.option('print', 'Print the environment and exit');
	t.option('list', 'List AWS profiles and exit');
	t.option('verbose', 'Log the server output');
	t.option('help', 'Show help', undefined, 'h');
	t.option('version', 'Show the version', undefined, 'v');

	const complete = t.command('complete', 'Print a shell completion script');
	complete.argument('shell', function (this: unknown, emit) {
		for (const shell of SHELLS) emit(shell, `${shell} completion script`);
	});
}

/**
 * Handles `complete ...`.
 *
 * Returns the exit code for the CLI, or `null` when the words are not a
 * completion request at all.
 */
export function handleCompletion(
	words: string[],
	options: { executable?: string; profiles?: string[] } = {},
): number | null {
	if (words.length === 0) return null;
	const [first, ...rest] = words;
	// Profile names come from the user's own AWS files, so `--profile=<TAB>`
	// completes the profiles they actually have.
	registerCompletionSpec(options.profiles ?? readProfiles());
	if (first === '--') {
		t.parse(rest);
		return 0;
	}
	if ((SHELLS as readonly string[]).includes(first)) {
		// `tab` prints the script; the executable is how the shell re-invokes us.
		t.setup(PROGRAM, options.executable ?? PROGRAM, first);
		return 0;
	}
	return null;
}

/** The completion script for a shell, for tests and docs. */
export function completionScript(shell: string, executable = PROGRAM): void {
	t.setup(PROGRAM, executable, shell);
}
