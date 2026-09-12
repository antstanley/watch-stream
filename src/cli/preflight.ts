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
import type { ApiErrorBody, ArchiveStatusResponse, IdentityResponse } from '../lib/types.ts';

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

/** Result of asking the app who the current credentials belong to. */
export type IdentityProbe =
	| { ok: true; identity: IdentityResponse }
	| { ok: false; code?: string; message: string };

/**
 * Asks the app to call `sts:GetCallerIdentity`.
 *
 * This is the cheapest way to answer "do these credentials work at all?", and it
 * is what tells the CLI not to offer a login for a profile that is already fine.
 */
export async function readIdentity(input: {
	baseUrl: string;
	region: string | null;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<IdentityProbe> {
	const { baseUrl, region, fetchImpl = fetch, timeoutMs = 15_000 } = input;
	const url = new URL('/api/identity', baseUrl);
	if (region !== null && region !== '') url.searchParams.set('region', region);

	try {
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (response.ok) {
			return { ok: true, identity: (await response.json()) as IdentityResponse };
		}
		const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
		return { ok: false, code: body?.code, message: body?.error ?? `HTTP ${response.status}` };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Short label for an ARN, for messages.
 *
 * Role ARNs end with the session name and not the role
 * (`assumed-role/MyRole/session-name`), so the role is the useful label; the
 * session name is stripped.
 */
export function shortIdentity(arn: string): string {
	if (arn.length === 0) return 'unknown';
	const resource = arn.split(':').at(-1) ?? arn;
	const parts = resource.split('/').filter((part) => part.length > 0);
	if (parts.length === 0) return arn;
	const [kind, name] = parts;
	if ((kind === 'assumed-role' || kind === 'role' || kind === 'user') && name !== undefined)
		return name;
	return parts.at(-1) ?? arn;
}

/** Result of asking the app about the local archive. */
export type ArchiveProbe =
	| { ok: true; status: ArchiveStatusResponse }
	| { ok: false; message: string };

/**
 * Asks the app what the local DuckDB archive holds.
 *
 * The route always answers 200 (an unavailable archive is reported inside the
 * payload), so a failure here means the app itself could not be reached. The CLI
 * only prints the result: nothing about startup depends on it.
 */
export async function readArchive(input: {
	baseUrl: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<ArchiveProbe> {
	const { baseUrl, fetchImpl = fetch, timeoutMs = 5000 } = input;
	try {
		const response = await fetchImpl(new URL('/api/archive', baseUrl), {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
		return { ok: true, status: (await response.json()) as ArchiveStatusResponse };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/** One line describing the archive for the startup banner. */
export function describeArchive(status: ArchiveStatusResponse): string {
	if (!status.available) return `local history unavailable: ${status.error ?? 'unknown reason'}`;
	const count =
		status.rows === 0
			? 'no events yet'
			: `${status.rows.toLocaleString('en-US')} event${status.rows === 1 ? '' : 's'}`;
	return `history ${count} at ${status.path}`;
}
