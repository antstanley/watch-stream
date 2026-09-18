/**
 * End-to-end check of the built CLI.
 *
 * Enable with `WATCH_TAIL_E2E=1 pnpm test:cli` after `pnpm build`: it starts the
 * real `dist/cli/bin.js`, waits for the served UI and stops it again. The
 * health endpoint needs no AWS credentials, so this runs without floci or an
 * AWS account.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const cliEntry = join(root, 'dist', 'cli', 'bin.js');
const enabled = process.env.WATCH_TAIL_E2E === '1' && existsSync(cliEntry);
const port = 4599;
const baseUrl = `http://127.0.0.1:${port}`;

type Running = { child: ReturnType<typeof spawn>; output: () => string; exited: Promise<number> };

/** Starts the CLI with plain output and collects everything it prints. */
function startCli(): Running {
	const child = spawn(
		process.execPath,
		// `--no-archive` keeps the spawned server away from any real archive file.
		[cliEntry, '--floci', '--port', String(port), '--no-open', '--no-archive'],
		{
			cwd: root,
			env: { ...process.env, WATCH_TAIL_PLAIN: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	let text = '';
	child.stdout?.on('data', (chunk: Buffer) => (text += chunk.toString()));
	child.stderr?.on('data', (chunk: Buffer) => (text += chunk.toString()));
	const exited = new Promise<number>((resolveExit) => {
		child.on('close', (code) => resolveExit(code ?? -1));
	});
	return { child, output: () => text, exited };
}

/** Polls the health endpoint until it answers or the deadline passes. */
async function waitForReady(timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return true;
		} catch {
			// Still booting.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	}
	return false;
}

describe.runIf(enabled)('watch-tail CLI', () => {
	let running: Running | null = null;

	afterAll(async () => {
		if (running !== null) {
			running.child.kill('SIGKILL');
			await running.exited.catch(() => undefined);
		}
	});

	it('serves the UI and reports its own health', async () => {
		running = startCli();
		expect(await waitForReady()).toBe(true);

		const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as {
			ok: boolean;
			endpoint: string | null;
			region: string;
		};
		expect(health.ok).toBe(true);
		expect(health.endpoint).toBe('http://localhost:4566');
		expect(health.region.length).toBeGreaterThan(0);

		const page = await (await fetch(baseUrl)).text();
		expect(page).toContain('watch-tail');
		expect(running.output()).toContain(`http://127.0.0.1:${port}`);
	}, 60_000);

	it('stops cleanly on SIGTERM', async () => {
		if (running === null) return;
		running.child.kill('SIGTERM');
		const code = await running.exited;
		expect(code).toBe(0);
	}, 30_000);
});
