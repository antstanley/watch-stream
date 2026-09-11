import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PROGRAM, SHELLS, completionScript } from '../src/cli/completions.ts';
import { readVersion, resolveCliRegion, type CliIo } from '../src/cli/index.ts';
import { browserCommand, findAppRoot } from '../src/cli/server.ts';
import { defaults } from '../src/cli/options.ts';

const created: string[] = [];

/** Creates a throwaway directory tree. */
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'watch-tail-'));
	created.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('findAppRoot', () => {
	it('walks up to the directory that holds the built server', () => {
		const rootDir = tempDir();
		mkdirSync(join(rootDir, 'build'), { recursive: true });
		mkdirSync(join(rootDir, 'dist', 'cli'), { recursive: true });
		writeFileSync(join(rootDir, 'build', 'index.js'), '');
		writeFileSync(join(rootDir, 'package.json'), '{"name":"watch-tail"}');

		expect(findAppRoot(join(rootDir, 'dist', 'cli'))).toBe(rootDir);
	});

	it('returns null when the app was never built', () => {
		expect(findAppRoot(tempDir())).toBeNull();
	});
});

describe('browserCommand', () => {
	it('uses the platform opener', () => {
		expect(browserCommand('http://localhost:4517', 'darwin')).toEqual({
			command: 'open',
			args: ['http://localhost:4517'],
		});
		expect(browserCommand('http://localhost:4517', 'win32').command).toBe('cmd');
		expect(browserCommand('http://localhost:4517', 'linux')).toEqual({
			command: 'xdg-open',
			args: ['http://localhost:4517'],
		});
	});
});

describe('readVersion', () => {
	it('reads the manifest next to the app root', () => {
		const appRoot = tempDir();
		writeFileSync(join(appRoot, 'package.json'), '{"name":"watch-tail","version":"9.9.9"}');
		expect(readVersion(appRoot)).toBe('9.9.9');
	});

	it('falls back when there is no manifest', () => {
		expect(readVersion(null)).toBe('0.0.0');
		expect(readVersion(tempDir())).toBe('0.0.0');
	});
});

/** Minimal io for {@link resolveCliRegion}. */
function regionIo(env: NodeJS.ProcessEnv, configText = ''): CliIo {
	return {
		stdout: () => undefined,
		stderr: () => undefined,
		env,
		interactive: false,
		readProfiles: () => [],
		readConfigText: () => configText,
		appRoot: null,
		version: '0.0.0',
		openBrowser: () => undefined,
		waitForHealth: async () => true,
		startServerImpl: (() => {
			throw new Error('not used');
		}) as CliIo['startServerImpl'],
		spawnImpl: (() => {
			throw new Error('not used');
		}) as CliIo['spawnImpl'],
		waitForStop: async () => 0,
	};
}

describe('resolveCliRegion', () => {
	it('prefers the flag, then the environment, then the profile', () => {
		const config = '[profile acme]\nregion = eu-central-1\n';

		expect(
			resolveCliRegion(
				{ ...defaults(), region: 'ap-south-1', profile: 'acme' },
				regionIo({}, config),
			),
		).toBe('ap-south-1');
		expect(
			resolveCliRegion(
				{ ...defaults(), profile: 'acme' },
				regionIo({ AWS_REGION: 'us-west-2' }, config),
			),
		).toBe('us-west-2');
		expect(resolveCliRegion({ ...defaults(), profile: 'acme' }, regionIo({}, config))).toBe(
			'eu-central-1',
		);
	});

	it('defaults a local emulator run to the seeded region', () => {
		expect(
			resolveCliRegion({ ...defaults(), endpoint: 'http://localhost:4566' }, regionIo({})),
		).toBe('us-east-1');
	});

	it('leaves the region unset when nothing resolves for real AWS', () => {
		expect(resolveCliRegion(defaults(), regionIo({}))).toBeNull();
	});
});

describe('shell completions', () => {
	it('offers the supported shells and program name', () => {
		expect([...SHELLS]).toEqual(['zsh', 'bash', 'fish', 'powershell']);
		expect(PROGRAM).toBe('watch-tail');
	});

	it('prints a script that knows the program name', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		completionScript('zsh');
		const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
		log.mockRestore();

		expect(printed).toContain('watch-tail');
		expect(printed.length).toBeGreaterThan(100);
	});
});
