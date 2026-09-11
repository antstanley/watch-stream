/**
 * Formatting helpers for the log viewer.
 *
 * CloudWatch log lines are often JSON (`{"level":"info",...}`); the viewer can
 * pretty-print them so nested payloads stay readable. Everything here is pure so
 * it can be unit tested without a DOM.
 */

/** Token kinds produced by {@link tokenizeJson}. */
type JsonTokenType =
	| 'key'
	| 'string'
	| 'number'
	| 'boolean'
	| 'null'
	| 'punctuation'
	| 'whitespace'
	| 'other';

export type JsonToken = {
	type: JsonTokenType;
	text: string;
};

export type FormattedMessage = {
	/** Text to render. */
	text: string;
	/** True when the message was JSON and pretty-printing was applied. */
	isJson: boolean;
	/** Parsed value when the message is JSON, otherwise `null`. */
	value: unknown;
};

/**
 * Parses a log message that is entirely JSON.
 *
 * Only objects and arrays count: a message that happens to be `42` or `"ok"` is
 * left alone, and anything that does not parse is not JSON. Leading and trailing
 * whitespace is ignored.
 */
export function detectJson(message: string): unknown | null {
	if (typeof message !== 'string') return null;
	const trimmed = message.trim();
	if (trimmed.length === 0) return null;
	const first = trimmed[0];
	if (first !== '{' && first !== '[') return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed === null || typeof parsed !== 'object') return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Returns the text to render for a log message.
 *
 * `prettyJson` is normally true: JSON messages are re-serialised with two-space
 * indentation. With `prettyJson` false the raw message is returned unchanged,
 * which is what the viewer's JSON toggle switches to.
 */
export function formatLogMessage(
	message: string,
	options: { prettyJson?: boolean } = {},
): FormattedMessage {
	const { prettyJson = true } = options;
	const value = detectJson(message);
	if (value === null || !prettyJson) {
		return { text: message, isJson: value !== null, value };
	}
	return { text: JSON.stringify(value, null, 2), isJson: true, value };
}

const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Splits pretty-printed JSON into coloured tokens.
 *
 * The concatenation of every token's `text` is always identical to the input, so
 * rendering tokens can never lose or alter a character. This is a display-only
 * scanner: it assumes well-formed JSON produced by `JSON.stringify`.
 */
export function tokenizeJson(text: string): JsonToken[] {
	const tokens: JsonToken[] = [];
	let index = 0;

	const push = (type: JsonTokenType, value: string): void => {
		if (value.length > 0) tokens.push({ type, text: value });
	};

	while (index < text.length) {
		const char = text[index];

		if (char === ' ' || char === '\n' || char === '\t' || char === '\r') {
			let end = index;
			while (end < text.length && ' \n\t\r'.includes(text[end])) end += 1;
			push('whitespace', text.slice(index, end));
			index = end;
			continue;
		}

		if (char === '"') {
			// A string: walk to the closing quote, honouring backslash escapes.
			let end = index + 1;
			while (end < text.length) {
				if (text[end] === '\\') {
					end += 2;
					continue;
				}
				if (text[end] === '"') break;
				end += 1;
			}
			const raw = text.slice(index, Math.min(end + 1, text.length));
			// A string followed by `:` is an object key.
			let lookahead = index + raw.length;
			while (lookahead < text.length && ' \n\t\r'.includes(text[lookahead])) lookahead += 1;
			push(text[lookahead] === ':' ? 'key' : 'string', raw);
			index += raw.length;
			continue;
		}

		if (
			char === '{' ||
			char === '}' ||
			char === '[' ||
			char === ']' ||
			char === ',' ||
			char === ':'
		) {
			push('punctuation', char);
			index += 1;
			continue;
		}

		if (text.startsWith('true', index) || text.startsWith('false', index)) {
			const literal = text.startsWith('true', index) ? 'true' : 'false';
			push('boolean', literal);
			index += literal.length;
			continue;
		}

		if (text.startsWith('null', index)) {
			push('null', 'null');
			index += 4;
			continue;
		}

		// A number, or anything unexpected: consume up to the next structural byte.
		let end = index;
		while (end < text.length && !'{}[],:" \n\t\r'.includes(text[end])) end += 1;
		const raw = text.slice(index, Math.max(end, index + 1));
		push(NUMBER_PATTERN.test(raw) ? 'number' : 'other', raw);
		index += raw.length;
	}

	return tokens;
}
