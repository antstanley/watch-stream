/**
 * Command-line surface of the `watch-tail` CLI.
 *
 * Parsing is pure so it can be unit tested: nothing here spawns a process or
 * touches the network. {@link parseCliArgs} never throws - it returns a
 * discriminated result the entry point turns into an exit code.
 */
import { parse } from '@bomb.sh/args';

/** Port the local UI listens on unless `--port` is given. */
export const DEFAULT_PORT = 4517;
/** Loopback default: the app proxies your AWS permissions, so keep it local. */
export const DEFAULT_HOST = '127.0.0.1';
/** Local emulator the `--floci` shorthand points at. */
export const FLOCI_ENDPOINT = 'http://localhost:4566';

export type CliOptions = {
	/** AWS profile passed to the server as `AWS_PROFILE`. */
	profile: string | null;
	/** Region override passed to the server as `AWS_REGION`. */
	region: string | null;
	/** TCP port for the local UI. */
	port: number;
	/** Interface to bind. Anything but loopback prints a warning. */
	host: string;
	/** Emulator endpoint (floci, LocalStack), or `null` for real AWS. */
	endpoint: string | null;
	/** Open the browser once the server is ready. */
	open: boolean;
	/** Print the child environment and exit. */
	print: boolean;
	/** List the AWS profiles found on disk and exit. */
	list: boolean;
	/** Show usage. */
	help: boolean;
	/** Show the version. */
	version: boolean;
	/** Extra logging. */
	verbose: boolean;
	/** `complete <shell>` / `complete -- <words>` payload, or `null`. */
	complete: string[] | null;
};

export type ParseCliResult = { ok: true; options: CliOptions } | { ok: false; error: string };

/** Flags accepted by the parser; anything else is reported as unknown. */
const KNOWN_FLAGS = new Set([
	'_',
	'profile',
	'p',
	'region',
	'r',
	'port',
	'host',
	'endpoint',
	'floci',
	'open',
	'no-open',
	'print',
	'list',
	'help',
	'h',
	'version',
	'v',
	'verbose',
]);

function asString(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

function asFlag(value: unknown): boolean {
	return value === true || value === 'true';
}

/**
 * Parses `watch-tail` arguments.
 *
 * Accepts `--flag value` and `--flag=value`, short aliases (`-p`, `-r`, `-h`,
 * `-v`), and the boolean negations `--open` / `--no-open`.
 */
export function parseCliArgs(argv: string[]): ParseCliResult {
	// `complete` is the shell-completion protocol, not a normal invocation. It is
	// matched against the raw words so the literal `--` separating the two
	// completion modes survives.
	if (argv[0] === 'complete') {
		return { ok: true, options: { ...defaults(), complete: argv.slice(1) } };
	}

	const words = argv.filter((word) => word !== '--');

	let parsed: Record<string, unknown>;
	try {
		parsed = parse(words, {
			alias: { p: 'profile', r: 'region', h: 'help', v: 'version' },
			boolean: ['floci', 'open', 'no-open', 'print', 'list', 'help', 'version', 'verbose'],
			string: ['profile', 'region', 'port', 'host', 'endpoint'],
			default: { open: true },
		}) as Record<string, unknown>;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const unknown = Object.keys(parsed).filter((key) => !KNOWN_FLAGS.has(key));
	if (unknown.length > 0) {
		return { ok: false, error: `Unknown option "${unknown[0]}"` };
	}

	const positionals = Array.isArray(parsed._) ? (parsed._ as unknown[]) : [];
	if (positionals.length > 0) {
		return {
			ok: false,
			error: `Unexpected argument "${String(positionals[0])}". Run watch-tail --help for usage.`,
		};
	}

	const portRaw = asString(parsed.port);
	const port = portRaw === null ? DEFAULT_PORT : parsePortValue(portRaw);
	if (port === null) {
		return { ok: false, error: `Invalid --port "${portRaw}": expected 1-65535` };
	}

	const endpoint = asFlag(parsed.floci) ? FLOCI_ENDPOINT : asString(parsed.endpoint);

	return {
		ok: true,
		options: {
			profile: asString(parsed.profile),
			region: asString(parsed.region),
			port,
			host: asString(parsed.host) ?? DEFAULT_HOST,
			endpoint,
			open: !asFlag(parsed['no-open']) && parsed.open !== false,
			print: asFlag(parsed.print),
			list: asFlag(parsed.list),
			help: asFlag(parsed.help),
			version: asFlag(parsed.version),
			verbose: asFlag(parsed.verbose),
			complete: null,
		},
	};
}

/** Defaults used by tests and by the `complete` short-circuit. */
export function defaults(): CliOptions {
	return {
		profile: null,
		region: null,
		port: DEFAULT_PORT,
		host: DEFAULT_HOST,
		endpoint: null,
		open: true,
		print: false,
		list: false,
		help: false,
		version: false,
		verbose: false,
		complete: null,
	};
}

/** Parses a port, returning `null` when it is not a usable TCP port. */
export function parsePortValue(value: string): number | null {
	const trimmed = value.trim();
	if (!/^\d{1,5}$/.test(trimmed)) return null;
	const port = Number(trimmed);
	return port >= 1 && port <= 65535 ? port : null;
}

/** True when the host is loopback only. */
export function isLoopbackHost(host: string): boolean {
	return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** Usage text shown by `--help` and after an argument error. */
export function usageText(): string {
	return `watch-tail - tail CloudWatch Logs in your browser

Usage
  watch-tail [options]

Options
  -p, --profile <name>   AWS profile to use (default: ambient credentials)
  -r, --region <code>    Region to open on (default: profile region, else AWS_REGION)
      --endpoint <url>   Point the app at a local emulator instead of AWS
      --floci            Shorthand for --endpoint ${FLOCI_ENDPOINT}
      --port <number>    Port for the local UI (default ${DEFAULT_PORT})
      --host <address>   Interface to bind (default ${DEFAULT_HOST}, loopback only)
      --no-open          Do not open a browser window
      --print            Print the environment that would be used, then exit
      --list             List the AWS profiles found on disk, then exit
      --verbose          Log the server's own output
  -h, --help             Show this help
  -v, --version          Show the version

Shell completions
  watch-tail complete <shell>      Print a completion script (zsh, bash, fish, powershell)
  watch-tail complete -- <words>   Completion protocol used by the generated script

Examples
  npx watch-tail
  npx watch-tail --profile my-profile --region eu-west-1
  npx watch-tail --floci --port 4600 --no-open

The app streams whatever your ambient AWS credentials can read. Credentials are
resolved by the AWS SDK (SSO, shared config, environment, instance role); the CLI
never stores them.`;
}
