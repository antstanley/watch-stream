/**
 * Unit tests for the profile launcher (`scripts/dev.ts`).
 *
 * Only the pure helpers are exercised: nothing here spawns a process, reads the
 * real `~/.aws` files or touches the network.
 */
import { describe, expect, it } from 'vitest';
import {
	type DevOptions,
	LOCAL_ENV_FILE,
	LOCAL_OVERRIDE_KEYS,
	REGION_KEYS,
	buildChildEnv,
	collectProfiles,
	describeChildEnv,
	parseArgs,
	parsePort,
	readProfileRegion,
	resolveRunRegion,
	signalExitCode,
	usageText,
} from '../scripts/dev.ts';

/** Parsed options of a successful case, so tests stay free of narrowing noise. */
function optionsOf(argv: string[]): DevOptions {
	const parsed = parseArgs(argv);
	if (!parsed.ok) throw new Error(`expected ${argv.join(' ')} to parse, got: ${parsed.error}`);
	return parsed.options;
}

/** Error message of a rejected case, or an empty string when it parsed. */
function errorOf(argv: string[]): string {
	const parsed = parseArgs(argv);
	return parsed.ok ? '' : parsed.error;
}

/** Environment of the launcher's own shell: `.env.local` is not loaded here. */
function shellBase(): NodeJS.ProcessEnv {
	return { PATH: '/usr/bin:/bin', HOME: '/Users/test' };
}

/** Environment of a floci run, as `.env.local` leaves it. */
function localBase(): NodeJS.ProcessEnv {
	return {
		PATH: '/usr/bin:/bin',
		HOME: '/Users/test',
		WATCH_STREAM_REGIONS: 'us-east-1,eu-west-1',
		AWS_ENDPOINT_URL: 'http://localhost.floci.io:4566',
		AWS_ENDPOINT_URL_LOGS: 'http://localhost.floci.io:4566',
		AWS_ACCESS_KEY_ID: 'test',
		AWS_SECRET_ACCESS_KEY: 'test',
		AWS_SESSION_TOKEN: 'floci-session',
		AWS_REGION: 'us-east-1',
		AWS_DEFAULT_REGION: 'us-east-1',
	};
}

describe('parseArgs', () => {
	it('returns empty defaults without arguments', () => {
		const parsed = parseArgs([]);
		expect(parsed).toEqual({
			ok: true,
			options: {
				profile: null,
				region: null,
				port: null,
				start: false,
				print: false,
				list: false,
				help: false,
			},
		});
	});

	it('reads a profile from `--profile value` and `--profile=value`', () => {
		expect(optionsOf(['--profile', 'acme-prod']).profile).toBe('acme-prod');
		expect(optionsOf(['--profile=acme-prod']).profile).toBe('acme-prod');
	});

	it('reads a region from both forms and trims blanks around it', () => {
		expect(optionsOf(['--region', 'us-east-2']).region).toBe('us-east-2');
		expect(optionsOf(['--region=us-west-2']).region).toBe('us-west-2');
		expect(optionsOf(['--profile', '  acme-prod  ']).profile).toBe('acme-prod');
	});

	it('reads a numeric port from both forms', () => {
		expect(optionsOf(['--port', '5179']).port).toBe(5179);
		expect(optionsOf(['--port=5179']).port).toBe(5179);
	});

	it('reads the boolean flags', () => {
		const { start, print, list, help } = optionsOf(['--start', '--print', '--list', '--help']);
		expect([start, print, list, help]).toEqual([true, true, true, true]);
	});

	it('accepts a bare positional profile name, as pnpm forwards it', () => {
		expect(optionsOf(['acme-prod']).profile).toBe('acme-prod');
	});

	it('tolerates a leading `--` inserted by pnpm', () => {
		const flags = optionsOf(['--', '--profile', 'acme-prod', '--port=5179']);
		expect(flags.profile).toBe('acme-prod');
		expect(flags.port).toBe(5179);
		expect(optionsOf(['--', 'acme-prod']).profile).toBe('acme-prod');
	});

	it('combines flags in any order', () => {
		expect(optionsOf(['--port', '5179', '--region=eu-west-1', '--profile', 'team-role'])).toEqual({
			profile: 'team-role',
			region: 'eu-west-1',
			port: 5179,
			start: false,
			print: false,
			list: false,
			help: false,
		});
	});

	it('reports an unknown flag instead of throwing', () => {
		expect(() => parseArgs(['--profile', 'x', '--nope'])).not.toThrow();
		expect(errorOf(['--profile', 'x', '--nope'])).toContain('--nope');
	});

	it('reports a missing value instead of throwing', () => {
		for (const argv of [['--profile'], ['--region'], ['--port'], ['--profile', '--list']]) {
			expect(errorOf(argv)).toContain('Missing value');
		}
	});

	it('rejects an unusable port value', () => {
		for (const value of ['abc', '0', '65536', '5179.5', '-1']) {
			expect(errorOf([`--port=${value}`])).toContain('--port');
		}
	});

	it('rejects a second positional argument', () => {
		expect(errorOf(['one', 'two'])).toContain('two');
	});

	it('rejects a value for a boolean flag', () => {
		expect(errorOf(['--start=yes'])).toContain('--start');
	});
});

describe('parsePort', () => {
	it('accepts ports in range and ignores padding', () => {
		expect(parsePort('1')).toBe(1);
		expect(parsePort('5173')).toBe(5173);
		expect(parsePort(' 65535 ')).toBe(65535);
	});

	it('rejects anything else', () => {
		for (const value of ['', '0', '65536', '-1', '1.5', '51a', '0x10']) {
			expect(parsePort(value)).toBeNull();
		}
	});
});

describe('collectProfiles', () => {
	const config = [
		'# ~/.aws/config',
		'[default]',
		'region = us-west-1',
		'',
		'[profile acme-prod]',
		'sso_session = acme-prod-session',
		'region = us-east-2',
		'[sso-session acme-prod-session]',
		'sso_start_url = https://example.awsapps.com/start/#',
		'[profile playroom]',
		'region = us-east-1',
		'; a comment',
	].join('\n');

	it('reads `[profile NAME]` from the config file and `[NAME]` from credentials', () => {
		const names = collectProfiles(config, '[work]\naws_access_key_id = AKIA\n');
		// Sorted, with `default` first.
		expect(names).toEqual(['default', 'acme-prod', 'playroom', 'work']);
	});

	it('puts default first and sorts the rest', () => {
		expect(collectProfiles('[default]\n', '[zeta]\n[alpha]\n')).toEqual([
			'default',
			'alpha',
			'zeta',
		]);
		expect(collectProfiles('', '[zeta]\n[alpha]\n')).toEqual(['alpha', 'zeta']);
	});

	it('takes `[default]` from either file', () => {
		expect(collectProfiles('', '[default]\naws_access_key_id = AKIA\n')).toEqual(['default']);
	});

	it('de-duplicates names that appear in both files', () => {
		expect(collectProfiles('[profile shared]\n', '[shared]\n')).toEqual(['shared']);
	});

	it('ignores comments, blank lines and config sections that are not profiles', () => {
		const names = collectProfiles(config, '# comment\n\n; comment\n');
		expect(names).not.toContain('sso-session acme-prod-session');
		expect(names).toEqual(['default', 'acme-prod', 'playroom']);
	});

	it('keeps profile names with spaces and dashes', () => {
		expect(collectProfiles('[profile my sso role]\n', '[legacy-key]\n')).toEqual([
			'legacy-key',
			'my sso role',
		]);
	});

	it('returns an empty list for missing files', () => {
		expect(collectProfiles('', '')).toEqual([]);
	});
});

describe('buildChildEnv', () => {
	it('sets AWS_PROFILE for the child', () => {
		const env = buildChildEnv({ base: localBase(), profile: 'acme-prod' });
		expect(env.AWS_PROFILE).toBe('acme-prod');
	});

	it('blanks the local emulator override keys only when a profile is given', () => {
		const withProfile = buildChildEnv({ base: localBase(), profile: 'acme-prod' });
		for (const key of LOCAL_OVERRIDE_KEYS) expect(withProfile[key]).toBe('');
		expect(LOCAL_OVERRIDE_KEYS).toEqual([
			'AWS_ENDPOINT_URL',
			'AWS_ENDPOINT_URL_LOGS',
			'AWS_ACCESS_KEY_ID',
			'AWS_SECRET_ACCESS_KEY',
			'AWS_SESSION_TOKEN',
		]);

		const withoutProfile = buildChildEnv({ base: localBase() });
		for (const key of LOCAL_OVERRIDE_KEYS) expect(withoutProfile[key]).toBe(localBase()[key]);
		expect(withoutProfile.AWS_PROFILE).toBeUndefined();
	});

	it('blanks the region pinned by the local env file when no region was resolved', () => {
		const env = buildChildEnv({ base: localBase(), profile: 'acme-prod' });
		for (const key of REGION_KEYS) expect(env[key]).toBe('');
		expect(REGION_KEYS).toEqual(['AWS_REGION', 'AWS_DEFAULT_REGION']);
	});

	it('applies a region resolved for the profile', () => {
		const region = resolveRunRegion({
			profile: 'acme-prod',
			base: shellBase(),
			configText: '[profile acme-prod]\nregion = us-east-2\n',
		});
		const env = buildChildEnv({ base: localBase(), profile: 'acme-prod', region });
		expect(env.AWS_REGION).toBe('us-east-2');
		expect(env.AWS_DEFAULT_REGION).toBe('us-east-2');
		expect(env.AWS_PROFILE).toBe('acme-prod');
		expect(env.AWS_ENDPOINT_URL).toBe('');
	});

	it('sets both region variables from --region', () => {
		const env = buildChildEnv({ base: {}, region: 'eu-west-1' });
		expect(env.AWS_REGION).toBe('eu-west-1');
		expect(env.AWS_DEFAULT_REGION).toBe('eu-west-1');
	});

	it('lets --region win over the profile and local settings', () => {
		const env = buildChildEnv({ base: localBase(), profile: 'acme-prod', region: 'ap-south-1' });
		expect(env.AWS_REGION).toBe('ap-south-1');
		expect(env.AWS_DEFAULT_REGION).toBe('ap-south-1');
		expect(env.AWS_PROFILE).toBe('acme-prod');
		expect(env.AWS_ENDPOINT_URL).toBe('');
	});

	it('keeps unrelated variables and does not mutate the input', () => {
		const base = Object.freeze(localBase());
		const env = buildChildEnv({ base, profile: 'acme-prod' });
		expect(env.PATH).toBe('/usr/bin:/bin');
		expect(env.HOME).toBe('/Users/test');
		expect(env.WATCH_STREAM_REGIONS).toBe('us-east-1,eu-west-1');
		expect(base.AWS_ENDPOINT_URL).toBe('http://localhost.floci.io:4566');
		expect(base.AWS_ACCESS_KEY_ID).toBe('test');
		expect(base.AWS_PROFILE).toBeUndefined();
		expect(env).not.toBe(base);
	});

	it('always returns a fresh object, even without options', () => {
		const base = localBase();
		const env = buildChildEnv({ base });
		expect(env).toEqual(base);
		expect(env).not.toBe(base);
	});

	it('treats a blank profile or region as absent', () => {
		const env = buildChildEnv({ base: localBase(), profile: '   ', region: '' });
		expect(env.AWS_PROFILE).toBeUndefined();
		expect(env.AWS_ENDPOINT_URL).toBe('http://localhost.floci.io:4566');
		expect(env.AWS_REGION).toBe('us-east-1');
	});
});

describe('readProfileRegion', () => {
	const config = [
		'[default]',
		'region = us-west-1',
		'[profile acme-prod]',
		'sso_session = acme-prod-session',
		'region = us-east-2',
		'[profile regionless]',
		'sso_session = thing',
		'[sso-session acme-prod-session]',
		'region = eu-west-2',
	].join('\n');

	it('reads the region of a profile section', () => {
		expect(readProfileRegion(config, 'acme-prod')).toBe('us-east-2');
	});

	it('reads the region of the default profile', () => {
		expect(readProfileRegion(config, 'default')).toBe('us-west-1');
	});

	it('returns null for a profile without a region or without a section', () => {
		expect(readProfileRegion(config, 'regionless')).toBeNull();
		expect(readProfileRegion(config, 'missing')).toBeNull();
		expect(readProfileRegion('', 'acme-prod')).toBeNull();
	});

	it('does not take a region from an sso-session or another profile', () => {
		expect(readProfileRegion(config, 'sso-session acme-prod-session')).toBeNull();
	});

	it('tolerates spacing and inline comments, and skips a blank value', () => {
		expect(readProfileRegion('[profile x]\n  region   =   ap-south-1 # home\n', 'x')).toBe(
			'ap-south-1',
		);
		expect(readProfileRegion('[profile x]\nregion =\nregion = eu-west-1\n', 'x')).toBe('eu-west-1');
		expect(readProfileRegion('[profile x]\n# region = us-east-1\n', 'x')).toBeNull();
	});
});

describe('resolveRunRegion', () => {
	const base = shellBase();
	const configText = '[profile acme-prod]\nregion = us-east-2\n';

	it('lets --region win', () => {
		expect(resolveRunRegion({ region: 'ap-south-1', profile: 'acme-prod', base, configText })).toBe(
			'ap-south-1',
		);
	});

	it('lets a region exported in the shell win over the profile, like the app does', () => {
		const exported = { ...base, AWS_REGION: 'eu-west-1' };
		expect(resolveRunRegion({ profile: 'acme-prod', base: exported, configText })).toBe(
			'eu-west-1',
		);
		const defaultOnly = { ...base, AWS_DEFAULT_REGION: 'sa-east-1' };
		expect(resolveRunRegion({ profile: 'acme-prod', base: defaultOnly, configText })).toBe(
			'sa-east-1',
		);
	});

	it('falls back to the profile region from ~/.aws/config', () => {
		expect(resolveRunRegion({ profile: 'acme-prod', base, configText })).toBe('us-east-2');
	});

	it('returns null when nothing can be resolved', () => {
		expect(resolveRunRegion({ profile: 'regionless', base, configText })).toBeNull();
		expect(resolveRunRegion({ base, configText })).toBeNull();
		expect(resolveRunRegion({ profile: 'acme-prod', base, configText: '' })).toBeNull();
		expect(
			resolveRunRegion({ region: '  ', profile: 'acme-prod', base, configText: '' }),
		).toBeNull();
	});
});

describe('describeChildEnv', () => {
	it('prints AWS_* and WATCH_STREAM_* entries as KEY=value, sorted, blanks included', () => {
		const env = buildChildEnv({ base: localBase(), profile: 'acme-prod', region: 'us-east-2' });
		env.PORT = '5179';
		const lines = describeChildEnv(env);
		expect(lines.every((line) => line.startsWith('AWS_') || line.startsWith('WATCH_STREAM_'))).toBe(
			true,
		);
		expect([...lines].toSorted()).toEqual(lines);
		expect(lines).toContain('AWS_PROFILE=acme-prod');
		expect(lines).toContain('AWS_REGION=us-east-2');
		expect(lines).toContain('AWS_DEFAULT_REGION=us-east-2');
		expect(lines).toContain('AWS_ENDPOINT_URL=');
		expect(lines).toContain('AWS_ACCESS_KEY_ID=');
		expect(lines.some((line) => line.startsWith('PATH='))).toBe(false);
		expect(lines.some((line) => line.startsWith('PORT='))).toBe(false);
		expect(lines.every((line) => line.includes('='))).toBe(true);
	});

	it('returns an empty list when nothing reproducible is set', () => {
		expect(describeChildEnv({ PATH: '/bin' })).toEqual([]);
		expect(describeChildEnv({})).toEqual([]);
	});
});

describe('usageText', () => {
	it('documents every flag and the launch commands', () => {
		const text = usageText();
		for (const flag of [
			'--profile',
			'--region',
			'--port',
			'--start',
			'--print',
			'--list',
			'--help',
		]) {
			expect(text).toContain(flag);
		}
		expect(text).toContain('dev:aws');
		expect(text.startsWith('Usage:')).toBe(true);
	});
});

describe('signalExitCode', () => {
	it('follows the shell convention and defaults to 1', () => {
		expect(signalExitCode('SIGINT')).toBe(130);
		expect(signalExitCode('SIGTERM')).toBe(143);
		expect(signalExitCode('SIGKILL')).toBe(1);
		expect(signalExitCode(null)).toBe(1);
	});
});

describe('LOCAL_ENV_FILE', () => {
	it('names the file written by `pnpm floci:env`', () => {
		expect(LOCAL_ENV_FILE).toBe('.env.local');
	});
});

describe('buildChildEnv and the local history archive', () => {
	it('leaves the archive variables alone when no archive settings are given', () => {
		const env = buildChildEnv({ base: localBase(), profile: 'acme-prod' });
		expect(env.WATCH_STREAM_ARCHIVE).toBeUndefined();
		expect(env.WATCH_STREAM_ARCHIVE_DB).toBeUndefined();
	});

	it('turns the archive off with a blank path', () => {
		const env = buildChildEnv({
			base: localBase(),
			archive: { enabled: false, path: null },
		});
		expect(env.WATCH_STREAM_ARCHIVE).toBe('off');
		expect(env.WATCH_STREAM_ARCHIVE_DB).toBe('');
	});

	it('forwards an explicit database path and keeps the archive on', () => {
		const env = buildChildEnv({
			base: localBase(),
			archive: { enabled: true, path: '/tmp/logs.duckdb' },
		});
		expect(env.WATCH_STREAM_ARCHIVE).toBe('');
		expect(env.WATCH_STREAM_ARCHIVE_DB).toBe('/tmp/logs.duckdb');
	});

	it('does not disturb the AWS variables', () => {
		const env = buildChildEnv({
			base: localBase(),
			profile: 'acme-prod',
			region: 'us-east-2',
			archive: { enabled: false, path: null },
		});
		expect(env.AWS_PROFILE).toBe('acme-prod');
		expect(env.AWS_REGION).toBe('us-east-2');
	});
});
