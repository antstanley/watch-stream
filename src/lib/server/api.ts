import { json } from '@sveltejs/kit';
import type { ApiErrorBody } from '$lib/types';

/**
 * Builds a JSON error response that never leaks stack traces.
 *
 * Use 400 for bad input, 502 for upstream CloudWatch Logs failures and 499
 * when the client aborted the request.
 */
export function apiError(
	status: number,
	message: string,
	code?: string,
	details?: string,
): Response {
	const body: ApiErrorBody = { error: message };
	if (code !== undefined) body.code = code;
	if (details !== undefined && details.length > 0) body.details = details;
	return json(body, { status });
}
