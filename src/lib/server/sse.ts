const NEWLINE_PATTERN = /\r?\n/g;

/**
 * Encodes a single server-sent event frame.
 *
 * The JSON payload is always kept on one line, so the frame is
 * `event: <name>\ndata: <json>\n\n`.
 */
export function sseFrame(event: string, data: unknown): string {
	const name = event.replace(NEWLINE_PATTERN, ' ').trim();
	const encoded = JSON.stringify(data) ?? 'null';
	return `event: ${name}\ndata: ${encoded.replace(NEWLINE_PATTERN, ' ')}\n\n`;
}

/** Encodes an SSE comment frame: `: <text>\n\n`. */
export function sseComment(text: string): string {
	return `: ${text.replace(NEWLINE_PATTERN, ' ')}\n\n`;
}
