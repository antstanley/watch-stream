import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { run, type CliIo } from '../src/cli/index.ts';
import type { Ui } from '../src/cli/ui.ts';
import type { startServer } from '../src/cli/server.ts';

/** Records everything the UI would have shown. */
function recorder(answers: boolean[] = []): Ui & { lines: string[]; asked: string[] } {
	const lines: string[] = [];
	const asked: string[] = [];
	const push = (text: string) => lines.push(text);
	return {
		lines,
		asked,
		interactive: false,
		intro: push,
		outro: push,
		info: push,
		warn: (text) => lines.push(`warn: ${text}`),
		startSpinner: push,
		stopSpinner: push,
		failSpinner: push,
		choose: async (_message, choices, initial) => initial ?? choices[0]?.value ?? null,
		confirm: async (message) => {
			asked.push(message);
			return answers.length > 0 ? (answers.shift() as boolean) : false;
		},
	};
}

type Harness = {
	io: Partial<CliIo>;
	ui: Ui & { lines: string[] };
	out: string[];
	err: string[];
	started: { env: NodeJS.ProcessEnv; port: number; host: string }[];
	opened: string[];
};

/** Builds a CLI harness with every side effect captured. */
function harness(overrides: Partial<CliIo> = {}): Harness {
	const ui = recorder();
	const out: string[] = [];
	const err: string[] = [];
	const started: Harness['started'] = [];
	const opened: string[] = [];
	const io: Partial<CliIo> = {
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
		// Explicit, so the advice does not depend on the CI platform (Linux has no
		// DISPLAY, which would add --remote).
		env: { PATH: '/usr/bin', AWS_CONFIG_FILE: '/nonexistent/config', WATCH_TAIL_HEADLESS: '0' },
		interactive: false,
		readProfiles: () => ['default', 'acme-prod'],
		readConfigText: () => '[profile acme-prod]\nregion = eu-west-1\n',
		appRoot: '/tmp/watch-tail-app',
		version: '1.2.3',
		openBrowser: (url) => opened.push(url),
		readCredentialsText: () => overrides.readCredentialsText?.() ?? '',
		probeCredentials: (input) =>
			(overrides.probeCredentials ?? (async () => ({ ok: true })))(input),
		runLogin: (command) => (overrides.runLogin ?? (async () => 0))(command),
		waitForHealth: async () => true,
		startServerImpl: ((input) => {
			started.push({ env: input.env, port: input.port, host: input.host });
			return { kill: () => true, exitCode: null, signalCode: null } as unknown as ChildProcess;
		}) as typeof startServer,
		waitForStop: async () => 0,
		ui,
		...overrides,
	};
	return { io, ui, out, err, started, opened };
}

describe('run: informational modes', () => {
	it('prints usage for --help', async () => {
		const h = harness();
		expect(await run(['--help'], h.io)).toBe(0);
		expect(h.out.join('\n')).toContain('watch-tail');
		expect(h.err).toHaveLength(0);
	});

	it('prints the version', async () => {
		const h = harness();
		expect(await run(['--version'], h.io)).toBe(0);
		expect(h.out).toEqual(['1.2.3']);
	});

	it('lists profiles', async () => {
		const h = harness();
		expect(await run(['--list'], h.io)).toBe(0);
		expect(h.out).toEqual(['default', 'acme-prod']);
	});

	it('notes when no profiles exist', async () => {
		const h = harness({ readProfiles: () => [] });
		expect(await run(['--list'], h.io)).toBe(0);
		expect(h.err.join('\n')).toContain('No profiles found');
	});

	it('fails with exit 2 and usage on a bad flag', async () => {
		const h = harness();
		expect(await run(['--nope'], h.io)).toBe(2);
		expect(h.err[0]).toContain('nope');
		expect(h.err.join('\n')).toContain('Usage');
	});
});

describe('run: --print', () => {
	it('shows the AWS environment for a profile run', async () => {
		const h = harness();
		expect(await run(['--print', '--profile', 'acme-prod'], h.io)).toBe(0);
		const text = h.out.join('\n');
		expect(text).toContain('AWS_PROFILE=acme-prod');
		expect(text).toContain('AWS_ENDPOINT_URL=');
		expect(text).toContain('AWS_REGION=eu-west-1');
	});

	it('shows the emulator endpoint and credentials for --floci', async () => {
		const h = harness();
		expect(await run(['--print', '--floci'], h.io)).toBe(0);
		const text = h.out.join('\n');
		expect(text).toContain('AWS_ENDPOINT_URL=http://localhost:4566');
		expect(text).toContain('AWS_ACCESS_KEY_ID=test');
		expect(text).toContain('AWS_REGION=us-east-1');
	});
});

describe('run: serving', () => {
	it('starts the server, waits for health and opens the browser', async () => {
		const h = harness();
		expect(await run(['--port', '4600', '--profile', 'acme-prod'], h.io)).toBe(0);

		expect(h.started).toHaveLength(1);
		expect(h.started[0].port).toBe(4600);
		expect(h.started[0].host).toBe('127.0.0.1');
		expect(h.started[0].env.AWS_PROFILE).toBe('acme-prod');
		expect(h.opened).toEqual(['http://127.0.0.1:4600']);
		expect(h.ui.lines.join('\n')).toContain('http://127.0.0.1:4600');
	});

	it('does not open a browser with --no-open', async () => {
		const h = harness();
		await run(['--no-open'], h.io);
		expect(h.opened).toHaveLength(0);
	});

	it('warns when binding a non-loopback interface', async () => {
		const h = harness();
		await run(['--host', '0.0.0.0', '--no-open'], h.io);
		expect(h.ui.lines.join('\n')).toContain('warn: binding 0.0.0.0');
	});

	it('exits 1 when the app is not built', async () => {
		const h = harness({ appRoot: null });
		expect(await run([], h.io)).toBe(1);
		expect(h.err.join('\n')).toContain('pnpm build');
		expect(h.started).toHaveLength(0);
	});

	it('exits 1 and stops the server when it never answers', async () => {
		const killed: string[] = [];
		const h = harness({
			waitForHealth: async () => false,
			startServerImpl: ((input) => {
				void input;
				return {
					kill: (signal?: string) => {
						killed.push(signal ?? 'SIGTERM');
						return true;
					},
					exitCode: null,
					signalCode: null,
					once: (event: string, listener: () => void) => {
						if (event === 'close') setTimeout(listener, 0);
						return undefined;
					},
				} as unknown as ChildProcess;
			}) as typeof startServer,
		});

		expect(await run(['--no-open'], h.io)).toBe(1);
		expect(h.ui.lines.join('\n')).toContain('did not answer');
		await vi.waitFor(() => expect(killed.length).toBeGreaterThan(0));
	});
});

describe('run: completions', () => {
	it('prints a completion script for a shell', async () => {
		const h = harness();
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		expect(await run(['complete', 'zsh'], h.io)).toBe(0);
		const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
		log.mockRestore();
		expect(printed).toContain('watch-tail');
	});
});

describe('run: credential preflight', () => {
	const SSO_CONFIG = '[profile acme-prod]\nsso_session = acme\nregion = eu-west-1\n';

	/** A harness whose first probe fails, then succeeds after a login. */
	function credentialHarness(options: {
		probeResults: Awaited<ReturnType<NonNullable<CliIo['probeCredentials']>>>[];
		answers?: boolean[];
		loginCode?: number;
	}) {
		const h = harness({
			readConfigText: () => SSO_CONFIG,
			ui: undefined,
		});
		const ui = recorder(options.answers ?? [true]);
		let call = 0;
		const logins: string[][] = [];
		h.io.ui = ui;
		h.io.probeCredentials = async () => {
			const result = options.probeResults[Math.min(call, options.probeResults.length - 1)];
			call += 1;
			return result;
		};
		h.io.runLogin = async (command) => {
			logins.push(command);
			return options.loginCode ?? 0;
		};
		return { ...h, ui, logins, probeCalls: () => call };
	}

	const failure = {
		ok: false as const,
		code: 'missing-credentials',
		message:
			"The SSO session token associated with profile=acme-prod was not found or is invalid. To refresh this SSO session run 'aws sso login'",
		credentialProblem: true,
	};

	it('offers `aws sso login` for an SSO profile and retries after it succeeds', async () => {
		const h = credentialHarness({ probeResults: [failure, { ok: true }] });

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([['sso', 'login', '--profile', 'acme-prod']]);
		expect(h.ui.asked.join(' ')).toContain('aws sso login --profile acme-prod');
		expect(h.ui.lines.join('\n')).toContain('signed in');
		expect(h.probeCalls()).toBe(2);
	});

	it('prints the command instead of running it when declined', async () => {
		const h = credentialHarness({ probeResults: [failure], answers: [false] });

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([]);
		expect(h.ui.lines.join('\n')).toContain('run it yourself');
		expect(h.ui.lines.join('\n')).toContain('aws sso login --profile acme-prod');
	});

	it('reports a login that fails', async () => {
		const h = credentialHarness({ probeResults: [failure], loginCode: 1 });

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.ui.lines.join('\n')).toContain('exited with code 1');
	});

	it('reports credentials that still fail after logging in', async () => {
		const h = credentialHarness({ probeResults: [failure, failure] });

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.ui.lines.join('\n')).toContain('still failing after login');
	});

	it('does not offer a login when the API fails for another reason', async () => {
		const h = credentialHarness({
			probeResults: [
				{ ok: false, code: 'unreachable', message: 'connection refused', credentialProblem: true },
			],
		});

		expect(await run([], h.io)).toBe(0);

		expect(h.ui.asked).toEqual([]);
		expect(h.ui.lines.join('\n')).toContain('could not list log groups');
	});

	it('adds --remote when there is no browser', async () => {
		const base = harness();
		const h = credentialHarness({ probeResults: [failure], answers: [true] });
		h.io.env = { ...base.io.env, WATCH_TAIL_HEADLESS: '1' };

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([['sso', 'login', '--profile', 'acme-prod', '--remote']]);
	});

	it('skips the check entirely for an emulator endpoint', async () => {
		const h = credentialHarness({ probeResults: [failure] });

		expect(await run(['--floci', '--no-open'], h.io)).toBe(0);

		expect(h.probeCalls()).toBe(0);
		expect(h.ui.asked).toEqual([]);
	});
});
