import { describe, expect, test } from 'vitest';
import { sseComment, sseFrame } from './sse';

describe('sseFrame', () => {
	test('encodes name and single-line JSON', () => {
		expect(sseFrame('ping', { at: 42 })).toBe('event: ping\ndata: {"at":42}\n\n');
	});

	test('escapes embedded newlines so the payload stays on one line', () => {
		const frame = sseFrame('log', { events: [{ message: 'first\nsecond' }] });
		const lines = frame.split('\n');
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe('event: log');
		expect(lines[1]).toBe('data: {"events":[{"message":"first\\nsecond"}]}');
		expect(lines[2]).toBe('');
		expect(JSON.parse(lines[1].slice('data: '.length))).toEqual({
			events: [{ message: 'first\nsecond' }],
		});
	});

	test('sanitizes the event name and serializes edge-case payloads', () => {
		expect(sseFrame('log\nend', null)).toBe('event: log end\ndata: null\n\n');
		expect(sseFrame('log', undefined)).toBe('event: log\ndata: null\n\n');
	});
});

describe('sseComment', () => {
	test('encodes a comment frame', () => {
		expect(sseComment('keep-alive')).toBe(': keep-alive\n\n');
	});

	test('flattens newlines', () => {
		expect(sseComment('a\nb')).toBe(': a b\n\n');
	});
});
