/**
 * `watch-tail` entry point.
 *
 * Responsibilities are deliberately thin: parse, resolve the AWS context, start
 * the packaged server, wait for it to answer, open a browser and translate
 * signals into an exit code. Everything with behaviour worth testing lives in
 * {@link ./options.ts}, {@link ./server.ts}, {@link ./ui.ts} or
 * `$lib/cli/aws.ts`, and the side effects are injectable through {@link CliIo}.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	buildChildEnv,
	describeChildEnv,
	isEmulatorEndpoint,
	isLocalEnvPresent,
	readConfigText,
	readProfiles,
	resolveRunRegion,
	signalExitCode,
} from '../lib/cli/aws.ts';
import { handleCompletion } from './completions.ts';
import { isLoopbackHost, parseCliArgs, usageText, type CliOptions } from './options.ts';
import {
	appRootFromHere,
	healthUrl,
	openBrowser as openBrowserDefault,
	startServer,
	stopServer,
	uiUrl,
	waitForHealth,
} from './server.ts';
import { createUi, isInteractive, type Ui } from './ui.ts';

/** Every side effect the CLI needs, so tests can run it in-process. */
export type CliIo = {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	env: NodeJS.ProcessEnv;
	/** True when animated output and prompts are safe. */
	interactive: boolean;
	/** Reads the AWS profiles on disk. */
	readProfiles: () => string[];
	/** Reads `~/.aws/config`. */
	readConfigText: () => string;
	/** Package root containing the built server, or `null` when not built. */
	appRoot: string | null;
	/** Version reported by `--version`. */
	version: string;
	/** Opens a URL in the browser. */
	openBrowser: (url: string) => void;
	/** Health poller. */
	waitForHealth: typeof waitForHealth;
	/** Used for tests that must not spawn a server. */
	startServerImpl: typeof startServer;
	spawnImpl: typeof spawn;
	/** Resolves on the next SIGINT/SIGTERM (or when the child exits). */
	waitForStop: (child: ChildProcess) => Promise<number>;
	/** Test seam for the presentation layer. */
	ui?: Ui;
};

/** Reads the version from the package manifest next to the app root. */
export function readVersion(appRoot: string | null): string {
	const fallback = '0.0.0';
	if (appRoot === null) return fallback;
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
		if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
			const version = (manifest as { version?: unknown }).version;
			if (typeof version === 'string' && version.length > 0) return version;
		}
	} catch {
		// A missing or unreadable manifest is not worth failing over.
	}
	return fallback;
}

/** Waits for SIGINT/SIGTERM, or for the server to exit on its own. */
function waitForStop(child: ChildProcess): Promise<number> {
	return new Promise<number>((resolveExit) => {
		let stopping = false;
		const stop = (): void => {
			if (stopping) {
				// A second signal means the server is stuck: stop it hard.
				child.kill('SIGKILL');
				return;
			}
			stopping = true;
			void stopServer(child).then(resolveExit);
		};
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
		process.on('exit', () => {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		});
		child.on('close', (code, signal) => resolveExit(code ?? signalExitCode(signal)));
	});
}

/** Real process environment for the CLI. */
function defaultIo(): CliIo {
	const appRoot = appRootFromHere();
	return {
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
		env: process.env,
		interactive: isInteractive(),
		readProfiles: () => readProfiles(),
		readConfigText: () => readConfigText(),
		appRoot,
		version: readVersion(appRoot),
		openBrowser: (url) => openBrowserDefault(url),
		waitForHealth,
		startServerImpl: startServer,
		spawnImpl: spawn,
		waitForStop,
	};
}

/** Region for this run: explicit flag, then the shell, then the profile. */
export function resolveCliRegion(options: CliOptions, io: CliIo): string | null {
	const resolved = resolveRunRegion({
		region: options.region,
		profile: options.profile,
		base: io.env,
		configText: io.readConfigText(),
	});
	if (resolved !== null) return resolved;
	// Emulator data is written per region and the demo fixtures live in us-east-1,
	// so a local run that resolves nothing opens on the seeded region.
	if (options.endpoint !== null && isEmulatorEndpoint(options.endpoint)) return 'us-east-1';
	return null;
}

/** Runs the CLI and returns its exit code. */
export async function run(argv: string[], overrides: Partial<CliIo> = {}): Promise<number> {
	const io: CliIo = { ...defaultIo(), ...overrides };

	const parsed = parseCliArgs(argv);
	if (!parsed.ok) {
		io.stderr(parsed.error);
		io.stderr(usageText());
		return 2;
	}
	const options = parsed.options;

	if (options.complete !== null) {
		const code = handleCompletion(options.complete, { profiles: io.readProfiles() });
		if (code !== null) return code;
	}
	if (options.help) {
		io.stdout(usageText());
		return 0;
	}
	if (options.version) {
		io.stdout(io.version);
		return 0;
	}
	if (options.list) {
		const profiles = io.readProfiles();
		for (const name of profiles) io.stdout(name);
		if (profiles.length === 0) {
			io.stderr('No profiles found in ~/.aws/config or ~/.aws/credentials.');
		}
		return 0;
	}

	const region = resolveCliRegion(options, io);
	const childEnv = buildChildEnv({
		base: io.env,
		profile: options.profile,
		region,
		endpoint: options.endpoint,
	});

	if (options.print) {
		for (const line of describeChildEnv(childEnv)) io.stdout(line);
		return 0;
	}

	if (io.appRoot === null) {
		io.stderr('Could not find the built app (build/index.js). Run `pnpm build` first.');
		return 1;
	}

	const ui = io.ui ?? createUi({ interactive: io.interactive });
	const url = uiUrl(options.host, options.port);

	ui.intro('watch-tail - CloudWatch Logs in your browser');
	if (options.endpoint !== null) {
		ui.info(`endpoint ${options.endpoint} (local emulator)`);
	} else if (options.profile !== null) {
		ui.info(`profile ${options.profile}`);
	}
	if (region !== null) ui.info(`region ${region}`);
	if (!isLoopbackHost(options.host)) {
		ui.warn(
			`binding ${options.host}: the app has no authentication and uses your AWS access, so anyone who can reach it can read your logs`,
		);
	}
	if (isLocalEnvPresent(io.appRoot) && options.profile !== null) {
		ui.warn('a .env.local with local emulator settings was found; it is ignored for this run');
	}

	ui.startSpinner('starting the local UI...');
	const child = io.startServerImpl({
		appRoot: io.appRoot,
		env: childEnv,
		port: options.port,
		host: options.host,
		verbose: options.verbose,
	});
	const ready = await io.waitForHealth(healthUrl(url), { fetchImpl: fetch });
	if (!ready) {
		ui.failSpinner(`the server did not answer on ${url}`);
		await stopServer(child);
		return 1;
	}
	ui.stopSpinner(`listening on ${url}`);
	if (options.open) io.openBrowser(url);
	ui.outro(`${url} (Ctrl+C to stop)`);

	const code = await io.waitForStop(child);
	ui.outro('stopped');
	return code;
}

/** Entry point used by `bin.ts`: runs the CLI and sets the exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	process.exitCode = await run(argv);
}
