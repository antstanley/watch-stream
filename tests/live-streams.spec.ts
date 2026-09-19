/**
 * The registry that lets a signal end the server's open event streams.
 *
 * `closeLiveStreams` is what turns "stop the server" into something that happens
 * at once rather than after adapter-node's thirty-second grace period, so what
 * it does with the registered closers is worth pinning down on its own.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	closeLiveStreams,
	liveStreamCount,
	registerLiveStream,
} from '../src/lib/server/live-streams.ts';

describe('registerLiveStream', () => {
	it('counts the streams that are open', () => {
		const before = liveStreamCount();
		const off = registerLiveStream(() => undefined);
		expect(liveStreamCount()).toBe(before + 1);
		off();
		expect(liveStreamCount()).toBe(before);
	});

	it('closes every registered stream, and reports how many', () => {
		const first = vi.fn<() => void>();
		const second = vi.fn<() => void>();
		registerLiveStream(first);
		registerLiveStream(second);

		expect(closeLiveStreams()).toBeGreaterThanOrEqual(2);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(liveStreamCount()).toBe(0);
	});

	it('keeps closing after one stream throws', () => {
		const broken = vi.fn<() => void>(() => {
			throw new Error('already gone');
		});
		const healthy = vi.fn<() => void>();
		registerLiveStream(broken);
		registerLiveStream(healthy);

		expect(() => closeLiveStreams()).not.toThrow();
		expect(healthy).toHaveBeenCalledTimes(1);
	});

	it('forgets a stream that unregistered itself', () => {
		const close = vi.fn<() => void>();
		const off = registerLiveStream(close);
		off();

		closeLiveStreams();
		expect(close).not.toHaveBeenCalled();
	});
});

// A signal sent to a real process catches the default-exit behavior that a
// mocked process.emit() cannot verify. No server or AWS endpoint is needed.
describe.skipIf(process.platform === 'win32')('stream signal ownership', () => {
	it.each([
		{ signal: 'SIGINT', withExitHook: false },
		{ signal: 'SIGTERM', withExitHook: false },
		{ signal: 'SIGINT', withExitHook: true },
		{ signal: 'SIGTERM', withExitHook: true },
	] as const)(
		'preserves $signal termination after hot reload (exit hook: $withExitHook)',
		async ({ signal, withExitHook }) => {
			const { spawn } = await import('node:child_process');
			const moduleUrl = new URL('../src/lib/server/live-streams.ts', import.meta.url).href;
			const script = `
   // Model signal-exit: only re-send when it is the sole remaining listener.
   function exitHook() {
    if (process.listenerCount(${JSON.stringify(signal)}) === 1) {
     process.off(${JSON.stringify(signal)}, exitHook);
     console.log('exit hook ran');
     process.kill(process.pid, ${JSON.stringify(signal)});
    }
   }
   if (${withExitHook}) process.on(${JSON.stringify(signal)}, exitHook);
   const first = await import(${JSON.stringify(moduleUrl)});
   first.registerLiveStream(() => console.log('first closed'));
   const second = await import(${JSON.stringify(moduleUrl + '?reload')});
   second.registerLiveStream(() => console.log('second closed'));
   console.log('listeners=' + process.listenerCount(${JSON.stringify(signal)}));
   setInterval(() => {}, 1000);
   process.kill(process.pid, ${JSON.stringify(signal)});
  `;
			const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
			let output = '';
			child.stdout.on('data', (chunk: Buffer) => {
				output += chunk.toString();
			});
			const watchdog = setTimeout(() => child.kill('SIGKILL'), 3000);
			try {
				const exit = await new Promise<NodeJS.Signals | null>((resolve) =>
					child.once('close', (_code, reason) => resolve(reason)),
				);
				expect(exit).toBe(signal);
				expect(output).toContain(`listeners=${withExitHook ? 2 : 1}`);
				expect(output.includes('exit hook ran')).toBe(withExitHook);
				expect(output).toContain('first closed');
				expect(output).toContain('second closed');
			} finally {
				clearTimeout(watchdog);
				child.kill('SIGKILL');
			}
		},
	);

	it('leaves shutdown to an existing server handler', async () => {
		const { spawn } = await import('node:child_process');
		const moduleUrl = new URL('../src/lib/server/live-streams.ts', import.meta.url).href;
		const child = spawn(process.execPath, [
			'--input-type=module',
			'-e',
			`
   process.on('SIGINT', () => setTimeout(() => process.exit(42), 25));
   const { registerLiveStream } = await import(${JSON.stringify(moduleUrl)});
   registerLiveStream(() => console.log('stream closed'));
   setInterval(() => {}, 1000);
   process.kill(process.pid, 'SIGINT');
  `,
		]);
		let output = '';
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString();
		});
		const watchdog = setTimeout(() => child.kill('SIGKILL'), 3000);
		try {
			const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
			expect(code).toBe(42);
			expect(output).toContain('stream closed');
		} finally {
			clearTimeout(watchdog);
			child.kill('SIGKILL');
		}
	});
});
