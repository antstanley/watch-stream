import { describe, expect, test } from 'vitest';
import { LEVEL_PARAM_HINT, parseLevelParam, withDetections } from './level-filter';
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

describe('withDetections', () => {
	test('detects both fields of an event that carries neither', () => {
		expect(withDetections([line('ERROR upstream 503 RequestId: 1a2b3c4d')])).toEqual([
			{
				id: 'id',
				timestamp: 1,
				message: 'ERROR upstream 503 RequestId: 1a2b3c4d',
				level: 'error',
				requestId: '1a2b3c4d',
			},
		]);
		expect(withDetections([line('{"level":"warn","requestId":"req-9f2c"}')])[0]).toMatchObject({
			level: 'warn',
			requestId: 'req-9f2c',
		});
		// No signal at all is reported as such, not guessed at.
		expect(withDetections([line('plain line')])[0]).toEqual({
			id: 'id',
			timestamp: 1,
			message: 'plain line',
			level: null,
			requestId: null,
		});
	});

	test('keeps a level that is already there, including an explicit null', () => {
		// Replaying the archive must not re-guess a stored level.
		expect(withDetections([line('ERROR looking, but debug', 'debug')])[0]?.level).toBe('debug');
		expect(withDetections([line('ERROR looking, but unknown', null)])[0]?.level).toBeNull();
	});

	test('keeps a stored request id and a stored verdict, and fills a missing one', () => {
		const stored = {
			id: 'id',
			timestamp: 1,
			message: '{"requestId":"from-message"}',
			level: 'info' as const,
			requestId: 'from-archive',
		};
		expect(withDetections([stored])[0]).toBe(stored);

		// An explicit `null` is the archive's answer: the row has no request id.
		const noId = { ...stored, requestId: null };
		expect(withDetections([noId])[0]).toBe(noId);

		// A row written before the column existed has no property at all, so the id
		// is still detected from the message.
		const legacy: LogEventDto = {
			id: 'id',
			timestamp: 1,
			message: 'ok {"requestId":"from-message"}',
			level: 'info',
		};
		expect(withDetections([legacy])[0]).toEqual({ ...legacy, requestId: 'from-message' });
	});

	test('does not mutate the events it was given', () => {
		const original = line('ERROR upstream 503 RequestId: 1a2b3c4d');
		const [tagged] = withDetections([original]);
		expect(original.level).toBeUndefined();
		expect(original.requestId).toBeUndefined();
		expect(tagged).not.toBe(original);
	});
});
