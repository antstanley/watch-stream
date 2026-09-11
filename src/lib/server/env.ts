import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env as privateEnv } from '$env/dynamic/private';

/**
 * Minimal view of the Node process, read through `globalThis` so this module
 * does not depend on ambient Node type declarations.
 */
type ProcessLike = {
	env?: Record<string, string | undefined>;
	cwd?: () => string;
	loadEnvFile?: (path?: string) => void;
};

/** Name of the git-ignored file that holds local (floci) connection settings. */
export const LOCAL_ENV_FILE = '.env.local';

let localEnvChecked = false;

/** Reads `process.env` through `globalThis`, so this file needs no `@types/node`. */
function processEnv(): Record<string, string | undefined> {
	const runtime = globalThis as unknown as { process?: ProcessLike };
	return runtime.process?.env ?? {};
}

/**
 * Loads a dotenv file into `process.env`.
 *
 * Existing environment variables win, matching `node --env-file` semantics.
 * Returns true only when a file was found and parsed.
 */
export function loadEnvFile(path: string): boolean {
	const runtime = globalThis as unknown as { process?: ProcessLike };
	const loader = runtime.process?.loadEnvFile;
	if (typeof loader !== 'function' || !existsSync(path)) return false;
	try {
		loader.call(runtime.process, path);
		return true;
	} catch {
		// A malformed file must not stop the server from booting.
		return false;
	}
}

/**
 * Loads `<cwd>/.env.local` once.
 *
 * SvelteKit exposes `.env` values through `$env/dynamic/private`, but the AWS
 * SDK's credential and region providers read `process.env` directly, so the
 * file has to be applied to the process too. Run `pnpm floci:up` to create it.
 */
function ensureLocalEnv(cwd?: string): boolean {
	if (localEnvChecked) return false;
	localEnvChecked = true;
	const runtime = globalThis as unknown as { process?: ProcessLike };
	const base = cwd ?? runtime.process?.cwd?.();
	if (base === undefined) return false;
	return loadEnvFile(join(base, LOCAL_ENV_FILE));
}

/**
 * Reads the effective server environment.
 *
 * `$env/dynamic/private` does resolve under vitest, but it is a snapshot taken
 * when the module is first evaluated, so the live `process.env` map is merged
 * last and wins.
 */
export function readEnv(): Record<string, string | undefined> {
	ensureLocalEnv();
	return { ...privateEnv, ...processEnv() };
}
