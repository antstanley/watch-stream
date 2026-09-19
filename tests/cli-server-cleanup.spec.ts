import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('kills the server if the CLI exits before readiness or waitForStop', async () => {
	const root = await mkdtemp(join(tmpdir(), 'watch-tail-exit-'));
	let serverPid: number | undefined;
	try {
		await mkdir(join(root, 'build'));
		await writeFile(join(root, 'build', 'index.js'), 'setInterval(() => {}, 1000);');
		const moduleUrl = new URL('../src/cli/server.ts', import.meta.url).href;
		const parent = spawn(process.execPath, [
			'--input-type=module',
			'-e',
			`
   const { startServer } = await import(${JSON.stringify(moduleUrl)});
   const child = startServer({ appRoot: ${JSON.stringify(root)}, env: process.env, port: 0, host: '127.0.0.1' });
   console.log(child.pid);
   // This is how the terminal spinner cancels, before waitForStop is called.
   process.exit(0);
  `,
		]);
		let output = '';
		parent.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString();
			serverPid = Number(output.trim()) || undefined;
		});
		const watchdog = setTimeout(() => {
			if (serverPid !== undefined) {
				try {
					process.kill(serverPid, 'SIGKILL');
				} catch {
					/* Already exited. */
				}
			}
			parent.kill('SIGKILL');
		}, 3000);
		try {
			const code = await new Promise<number | null>((resolve) => parent.once('close', resolve));
			expect(code).toBe(0);
			expect(serverPid).toBeDefined();
			await expect
				.poll(
					() => {
						try {
							process.kill(serverPid!, 0);
							return true;
						} catch {
							return false;
						}
					},
					{ timeout: 2000 },
				)
				.toBe(false);
		} finally {
			clearTimeout(watchdog);
			parent.kill('SIGKILL');
		}
	} finally {
		if (serverPid !== undefined) {
			try {
				process.kill(serverPid, 'SIGKILL');
			} catch {
				/* Already exited. */
			}
		}
		await rm(root, { recursive: true, force: true });
	}
});
