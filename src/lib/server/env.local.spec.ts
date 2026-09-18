import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_ENV_FILE, loadEnvFile } from './env';

const created: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'watch-tail-env-'));
	created.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('loadEnvFile', () => {
	it('loads variables from a dotenv file', () => {
		const dir = tempDir();
		const file = join(dir, LOCAL_ENV_FILE);
		writeFileSync(file, 'WATCH_TAIL_SPEC_ENDPOINT=http://127.0.0.1:4566\n');

		expect(loadEnvFile(file)).toBe(true);
		expect(process.env.WATCH_TAIL_SPEC_ENDPOINT).toBe('http://127.0.0.1:4566');
	});

	it('keeps variables that are already set', () => {
		const dir = tempDir();
		const file = join(dir, LOCAL_ENV_FILE);
		writeFileSync(file, 'WATCH_TAIL_SPEC_KEEP=from-file\n');
		process.env.WATCH_TAIL_SPEC_KEEP = 'from-process';

		expect(loadEnvFile(file)).toBe(true);
		expect(process.env.WATCH_TAIL_SPEC_KEEP).toBe('from-process');
	});

	it('reports a missing file instead of throwing', () => {
		expect(loadEnvFile(join(tempDir(), 'missing.env'))).toBe(false);
	});
});
