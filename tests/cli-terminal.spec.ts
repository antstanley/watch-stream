import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const enabled =
	process.env.WATCH_TAIL_E2E === '1' &&
	process.platform !== 'win32' &&
	existsSync(join(root, 'dist/cli/index.js'));
const execute = promisify(execFile);

describe.runIf(enabled)('interactive CLI terminal shutdown', () => {
	it.each([false, true])(
		'Ctrl+C stops both processes after a profile restart (verbose=%s)',
		async (verbose) => {
			const { stdout } = await execute(
				'python3',
				[
					join(root, 'tests/fixtures/cli-profile-pty.py'),
					process.execPath,
					join(root, 'tests/fixtures/cli-profile-restart.mjs'),
					String(verbose),
				],
				{ timeout: 45_000 },
			);
			expect(JSON.parse(stdout)).toEqual({ isig: true, cliExited: true, portReleased: true });
		},
		50_000,
	);
});
