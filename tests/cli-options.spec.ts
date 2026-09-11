import { describe, expect, it } from 'vitest';
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	FLOCI_ENDPOINT,
	defaults,
	isLoopbackHost,
	parseCliArgs,
	parsePortValue,
	usageText,
} from '../src/cli/options.ts';

/** Parses argv and fails loudly when it should have parsed. */
function optionsOf(argv: string[]) {
	const parsed = parseCliArgs(argv);
	if (!parsed.ok) throw new Error(`expected ${argv.join(' ')} to parse, got: ${parsed.error}`);
	return parsed.options;
}

/** Parses argv and returns the error message, or an empty string. */
function errorOf(argv: string[]): string {
	const parsed = parseCliArgs(argv);
	return parsed.ok ? '' : parsed.error;
}

describe('parseCliArgs defaults', () => {
	it('listens on loopback with the browser opening', () => {
		const options = optionsOf([]);
		expect(options).toEqual(defaults());
		expect(options.port).toBe(DEFAULT_PORT);
		expect(options.host).toBe(DEFAULT_HOST);
		expect(options.open).toBe(true);
		expect(options.profile).toBeNull();
		expect(options.endpoint).toBeNull();
	});
});

describe('parseCliArgs flags', () => {
	it('accepts values in both forms, with aliases', () => {
		expect(optionsOf(['--profile', 'acme']).profile).toBe('acme');
		expect(optionsOf(['--profile=acme']).profile).toBe('acme');
		expect(optionsOf(['-p', 'acme']).profile).toBe('acme');
		expect(optionsOf(['--region', 'eu-west-1']).region).toBe('eu-west-1');
		expect(optionsOf(['-r', 'eu-west-1']).region).toBe('eu-west-1');
		expect(optionsOf(['--port', '5000']).port).toBe(5000);
		expect(optionsOf(['--port=5000']).port).toBe(5000);
		expect(optionsOf(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
	});

	it('trims blanks and treats them as absent', () => {
		expect(optionsOf(['--profile', '  acme  ']).profile).toBe('acme');
		expect(optionsOf(['--profile=']).profile).toBeNull();
	});

	it('maps the emulator flags', () => {
		expect(optionsOf(['--floci']).endpoint).toBe(FLOCI_ENDPOINT);
		expect(optionsOf(['--endpoint', 'http://localhost:9999']).endpoint).toBe(
			'http://localhost:9999',
		);
		expect(optionsOf(['--floci=true']).endpoint).toBe(FLOCI_ENDPOINT);
	});

	it('handles the boolean switches', () => {
		expect(optionsOf(['--no-open']).open).toBe(false);
		expect(optionsOf(['--open']).open).toBe(true);
		expect(optionsOf(['--print']).print).toBe(true);
		expect(optionsOf(['--list']).list).toBe(true);
		expect(optionsOf(['--verbose']).verbose).toBe(true);
		expect(optionsOf(['--help']).help).toBe(true);
		expect(optionsOf(['-h']).help).toBe(true);
		expect(optionsOf(['--version']).version).toBe(true);
		expect(optionsOf(['-v']).version).toBe(true);
	});

	it('tolerates the pnpm separator and takes the last value', () => {
		expect(optionsOf(['--', '--profile', 'acme']).profile).toBe('acme');
		expect(optionsOf(['--profile', 'one', '--profile', 'two']).profile).toBe('two');
	});

	it('short-circuits the completion protocol', () => {
		expect(optionsOf(['complete', 'zsh']).complete).toEqual(['zsh']);
		expect(optionsOf(['complete', '--', '--profile', 'a']).complete).toEqual([
			'--',
			'--profile',
			'a',
		]);
	});
});

describe('parseCliArgs errors', () => {
	it('rejects unknown options', () => {
		expect(errorOf(['--nope'])).toContain('nope');
		expect(errorOf(['--profile', 'a', '--nope'])).toContain('nope');
	});

	it('rejects stray positionals', () => {
		expect(errorOf(['serve'])).toContain('serve');
	});

	it('rejects an unusable port', () => {
		expect(errorOf(['--port', 'abc'])).toContain('--port');
		expect(errorOf(['--port', '99999'])).toContain('--port');
	});

	it('never throws', () => {
		for (const argv of [[], ['--port'], ['---'], ['--profile'], ['--port=-1']]) {
			expect(() => parseCliArgs(argv)).not.toThrow();
		}
	});
});

describe('parsePortValue', () => {
	it('accepts usable TCP ports only', () => {
		expect(parsePortValue('1')).toBe(1);
		expect(parsePortValue(' 4517 ')).toBe(4517);
		expect(parsePortValue('65535')).toBe(65535);
		for (const value of ['0', '65536', '-1', '1.5', 'abc', '']) {
			expect(parsePortValue(value)).toBeNull();
		}
	});
});

describe('isLoopbackHost', () => {
	it('knows which hosts are local', () => {
		expect(isLoopbackHost('127.0.0.1')).toBe(true);
		expect(isLoopbackHost('localhost')).toBe(true);
		expect(isLoopbackHost('::1')).toBe(true);
		expect(isLoopbackHost('0.0.0.0')).toBe(false);
		expect(isLoopbackHost('192.168.1.10')).toBe(false);
	});
});

describe('usageText', () => {
	it('documents every flag and the completion protocol', () => {
		const text = usageText();
		for (const token of [
			'--profile',
			'--region',
			'--endpoint',
			'--floci',
			'--port',
			'--host',
			'--no-open',
			'--print',
			'--list',
			'--verbose',
			'--help',
			'--version',
			'complete',
		]) {
			expect(text).toContain(token);
		}
		expect(text).toContain(String(DEFAULT_PORT));
		expect(text).toContain('watch-tail');
	});
});
