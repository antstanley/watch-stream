import { describe, expect, test } from 'vitest';
import { detectJson, formatLogMessage, tokenizeJson } from './log-format';

describe('detectJson', () => {
	test('accepts objects and arrays', () => {
		expect(detectJson('{"level":"info"}')).toEqual({ level: 'info' });
		expect(detectJson('  [1,2,3]  ')).toEqual([1, 2, 3]);
		expect(detectJson('{"a":{"b":[{"c":null}]}}')).toEqual({ a: { b: [{ c: null }] } });
	});

	test('rejects text that is not entirely JSON', () => {
		expect(detectJson('START RequestId: abc')).toBeNull();
		expect(detectJson('INFO {"level":"info"}')).toBeNull();
		expect(detectJson('{"level":"info"} trailing')).toBeNull();
		expect(detectJson('{not json}')).toBeNull();
		expect(detectJson('')).toBeNull();
		expect(detectJson('   ')).toBeNull();
	});

	test('rejects bare scalars even when they parse', () => {
		expect(detectJson('42')).toBeNull();
		expect(detectJson('"a string"')).toBeNull();
		expect(detectJson('true')).toBeNull();
		expect(detectJson('null')).toBeNull();
	});
});

describe('formatLogMessage', () => {
	test('pretty-prints JSON with two-space indentation', () => {
		const result = formatLogMessage('{"level":"info","order":{"id":"ord_1","items":[1,2]}}');
		expect(result.isJson).toBe(true);
		expect(result.text).toBe(
			[
				'{',
				'  "level": "info",',
				'  "order": {',
				'    "id": "ord_1",',
				'    "items": [',
				'      1,',
				'      2',
				'    ]',
				'  }',
				'}',
			].join('\n'),
		);
	});

	test('leaves non-JSON messages untouched', () => {
		const line = 'START RequestId: 8f2c Version: $LATEST';
		const result = formatLogMessage(line);
		expect(result.text).toBe(line);
		expect(result.isJson).toBe(false);
	});

	test('returns the raw message when pretty printing is off', () => {
		const line = '{"level":"info"}';
		const result = formatLogMessage(line, { prettyJson: false });
		expect(result.text).toBe(line);
		expect(result.isJson).toBe(true);
	});
});

describe('tokenizeJson', () => {
	const sample = JSON.stringify(
		{
			level: 'info',
			msg: 'cart validated',
			items: 3,
			ok: true,
			nothing: null,
			nested: { list: [1, -2.5, 3e4], text: 'a "quoted" \\ value' },
			unicode: 'caf\u00e9 \u2603',
		},
		null,
		2,
	);

	test('round-trips the input exactly', () => {
		expect(
			tokenizeJson(sample)
				.map((token) => token.text)
				.join(''),
		).toBe(sample);
	});

	test('classifies keys, strings, numbers, booleans and null', () => {
		const tokens = tokenizeJson(sample);
		expect(tokens.find((token) => token.text === '"level"')?.type).toBe('key');
		expect(tokens.find((token) => token.text === '"info"')?.type).toBe('string');
		expect(tokens.find((token) => token.text === 'true')?.type).toBe('boolean');
		expect(tokens.find((token) => token.text === 'null')?.type).toBe('null');
		// `JSON.stringify` normalises 3e4 to 30000 before this ever reaches the tokenizer.
		expect(tokens.filter((token) => token.type === 'number').map((token) => token.text)).toEqual([
			'3',
			'1',
			'-2.5',
			'30000',
		]);
	});

	test('handles escapes, unicode and empty input', () => {
		const escaped = JSON.stringify({ msg: 'line\nbreak "quoted" \\ slash \u2603' }, null, 2);
		expect(
			tokenizeJson(escaped)
				.map((token) => token.text)
				.join(''),
		).toBe(escaped);
		expect(tokenizeJson('')).toEqual([]);
	});

	test('never loses characters for degenerate input', () => {
		for (const text of ['{', '"unterminated', 'nul', '12ab', '{{{}}}']) {
			expect(
				tokenizeJson(text)
					.map((token) => token.text)
					.join(''),
			).toBe(text);
		}
	});
});
