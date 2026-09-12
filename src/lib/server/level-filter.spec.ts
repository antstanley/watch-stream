import { describe, expect, test } from 'vitest';
import { LEVEL_PARAM_HINT, parseLevelParam, withLevels } from './level-filter';
import type { LogEventDto } from '$lib/types';

const line = (message: string, level?: LogEventDto['level']): LogEventDto =>
	level === undefined
		? { id: 'id', timestamp: 1, message }
		: { id: 'id', timestamp: 1, message, level };

describe('parseLevelParam', () => {
	test('treats an absent or blank value as every level', () => {
		expect(parseLevelParam(null)).toBeNull();
		expect(parseLevelParam(undefined)).toBeNull();
		expect(parseLevelParam('   ')).toBeNull();
		expect(parseLevelParam(' , ')).toBeNull();
	});

	test('parses one or several levels, lower-cased and de-duplicated', () => {
		expect(parseLevelParam('error')).toEqual(['error']);
		expect(parseLevelParam('ERROR, warn')).toEqual(['error', 'warn']);
		expect(parseLevelParam('warn,warn,info')).toEqual(['warn', 'info']);
		expect(parseLevelParam(' error , , debug ')).toEqual(['error', 'debug']);
	});

	test('reports an unknown level instead of ignoring it', () => {
		expect(parseLevelParam('shouty')).toBeUndefined();
		expect(parseLevelParam('error,shouty')).toBeUndefined();
		expect(LEVEL_PARAM_HINT).toContain('error, warn, info, debug');
	});
});

describe('withLevels', () => {
	test('detects the level of an event that has none', () => {
		expect(withLevels([line('ERROR upstream 503')])).toEqual([
			{ id: 'id', timestamp: 1, message: 'ERROR upstream 503', level: 'error' },
		]);
		expect(withLevels([line('{"level":"warn"}')])[0]?.level).toBe('warn');
		expect(withLevels([line('plain line')])[0]?.level).toBeNull();
	});

	test('keeps a level that is already there, including an explicit null', () => {
		// Replaying the archive must not re-guess a stored level.
		expect(withLevels([line('ERROR looking, but debug', 'debug')])[0]?.level).toBe('debug');
		expect(withLevels([line('ERROR looking, but unknown', null)])[0]?.level).toBeNull();
	});

	test('does not mutate the events it was given', () => {
		const original = line('ERROR upstream 503');
		const [tagged] = withLevels([original]);
		expect(original.level).toBeUndefined();
		expect(tagged).not.toBe(original);
	});
});
