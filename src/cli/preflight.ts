/**
 * Startup credential check for the CLI.
 *
 * Rather than resolving credentials twice, the CLI asks the running app: the
 * `/api/log-groups` route uses the same SDK client and the same environment, and
 * it already maps provider failures onto codes such as `missing-credentials`. If
 * that comes back as a credential failure, {@link ./credentials.ts} decides which
 * login command repairs it, and the CLI can run it and retry.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import type { ApiErrorBody } from '../lib/types.ts';

export type CredentialProbe =
	| { ok: true }
	| { ok: false; code?: string; message: string; credentialProblem: boolean };

export type ProbeInput = {
	/** Base URL of the running app. */
	baseUrl: string;
	/** Region to query; the app resolves its own default when empty. */
	region: string | null;
	fetchImpl?: typeof fetch;
	/** Abort the probe quickly; it is a startup nicety, not a health gate. */
	timeoutMs?: number;
};

/**
 * Asks the app whether it can list log groups.
 *
 * Only the first error is reported: with no credentials every region fails the
 * same way, and the point is to spot it early, not to be exhaustive.
 */
export async function probeCredentials(input: ProbeInput): Promise<CredentialProbe> {
	const { baseUrl, region, fetchImpl = fetch, timeoutMs = 10_000 } = input;
	const url = new URL('/api/log-groups', baseUrl);
	if (region !== null && region !== '') url.searchParams.set('region', region);
	url.searchParams.set('limit', '1');

	try {
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (response.ok) return { ok: true };
		const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
		const message = body?.error ?? `HTTP ${response.status}`;
		return { ok: false, code: body?.code, message, credentialProblem: true };
	} catch (error) {
		// A transport failure is not a credentials problem.
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
			credentialProblem: false,
		};
	}
}

/** Runs a login command with the terminal attached, so the browser flow works. */
export function runLogin(
	command: string[],
	options: { spawnImpl?: typeof spawn; stdio?: 'inherit' | 'ignore' } = {},
): Promise<number> {
	const { spawnImpl = spawn, stdio = 'inherit' } = options;
	return new Promise<number>((resolveExit) => {
		let child: ChildProcess;
		try {
			child = spawnImpl('aws', command, { stdio, shell: false });
		} catch {
			resolveExit(127);
			return;
		}
		child.on('error', () => resolveExit(127));
		child.on('close', (code) => resolveExit(code ?? 1));
	});
}

/**
 * True when there is no browser to drive the login (SSH, headless).
 *
 * `WATCH_TAIL_HEADLESS` overrides the guess in both directions: `1` forces the
 * `--remote` flow, `0` forces the browser flow on a host that looks headless
 * (a Linux container with a browser proxy, for example).
 */
export function isHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WATCH_TAIL_HEADLESS === '1') return true;
	if (env.WATCH_TAIL_HEADLESS === '0') return false;
	if (env.SSH_CONNECTION !== undefined && env.SSH_CONNECTION !== '') return true;
	if (process.platform === 'linux' && env.DISPLAY === undefined) return true;
	return false;
}
