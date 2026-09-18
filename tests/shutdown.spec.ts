/**
 * Stopping the server while it is streaming.
 *
 * A live tail is a connection that never ends on its own, and adapter-node waits
 * for in-flight connections when it shuts down - thirty seconds by default. A
 * server with a browser attached therefore took half a minute to stop after a
 * Ctrl+C, which is the bug this file exists to prevent coming back: the app now
 * ends its own streams on a signal, so the process exits at once.
 *
 * Enable with `pnpm test:cli` after `pnpm build` (it runs the real server).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const serverEntry = join(root, 'build', 'index.js');
const enabled = process.env.WATCH_TAIL_E2E === '1' && existsSync(serverEntry);
const port = 4598;
const baseUrl = `http://127.0.0.1:${port}`;

/** Waits until the server answers `/api/health`, or gives up. */
async function waitForHealth(timeoutMs = 20_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/api/health`);
			if (response.ok) {
				await response.body?.cancel();
				return true;
			}
		} catch {
			// Not up yet.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
	}
	return false;
}

type Running = {
	child: ReturnType<typeof spawn>;
	/** Resolves with the exit code once the process is gone. */
	exited: Promise<number>;
};

function startServer(): Running {
	const child = spawn(process.execPath, [serverEntry], {
		cwd: root,
		env: {
			...process.env,
			PORT: String(port),
			HOST: '127.0.0.1',
			// No AWS credentials and no archive: the health check and the stream's
			// ready frame do not need either, and this never touches a real file.
			WATCH_TAIL_ARCHIVE: 'off',
			AWS_ENDPOINT_URL: 'http://127.0.0.1:4597',
			AWS_ENDPOINT_URL_LOGS: 'http://127.0.0.1:4597',
			AWS_ACCESS_KEY_ID: 'test',
			AWS_SECRET_ACCESS_KEY: 'test',
			AWS_REGION: 'us-east-1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const exited = new Promise<number>((resolveExit) => {
		child.on('close', (code) => resolveExit(code ?? -1));
	});
	return { child, exited };
}

const running: Running[] = [];

afterEach(async () => {
	for (const entry of running.splice(0)) {
		entry.child.kill('SIGKILL');
		await entry.exited;
	}
});

describe.runIf(enabled)('stopping a streaming server', () => {
	it('exits promptly when a live tail is connected', async () => {
		const server = startServer();
		running.push(server);
		expect(await waitForHealth()).toBe(true);

		// A real live tail, kept open for the whole test: this is the connection
		// that used to hold the shutdown for thirty seconds.
		const controller = new AbortController();
		const response = await fetch(
			`${baseUrl}/api/stream?region=us-east-1&group=%2Faws%2Flambda%2Fcheckout-api`,
			{ signal: controller.signal },
		);
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (reader === undefined) return;

		// The `ready` frame proves the tail is established before we stop the server.
		const firstFrame = await reader.read();
		expect(new TextDecoder().decode(firstFrame.value ?? new Uint8Array())).toContain(
			'event: ready',
		);

		const startedAt = Date.now();
		server.child.kill('SIGINT');
		const code = await Promise.race([
			server.exited,
			new Promise<number>((resolveTimeout) => setTimeout(() => resolveTimeout(-999), 8_000)),
		]);
		const elapsed = Date.now() - startedAt;

		// The bound is deliberately generous: the point is "immediately", not the
		// exact milliseconds, and the old behaviour was thirty seconds.
		expect(elapsed).toBeLessThan(5_000);
		expect(code).not.toBe(-999);
		controller.abort();
	}, 30_000);
});
