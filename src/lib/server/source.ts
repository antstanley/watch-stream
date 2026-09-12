/**
 * The `source` query parameter shared by `/api/stream` and `/api/log-groups`.
 *
 * Parsing lives here instead of in the routes so both endpoints accept exactly
 * the same values and report the same error.
 */
import type { StreamSource } from '$lib/types';

/** Message used for every rejected `source` value. */
export const SOURCE_PARAM_HINT = 'Invalid source: expected "cloudwatch" or "archive"';

/** The default when the parameter is absent. */
export const DEFAULT_SOURCE: StreamSource = 'cloudwatch';

/**
 * Parses the `source` parameter.
 *
 * Returns `null` for an unrecognised value so the caller can answer 400 without
 * guessing, and {@link DEFAULT_SOURCE} when the parameter is missing or blank.
 */
export function parseSourceParam(value: string | null | undefined): StreamSource | null {
	if (value === null || value === undefined) return DEFAULT_SOURCE;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === '') return DEFAULT_SOURCE;
	if (trimmed === 'cloudwatch' || trimmed === 'archive') return trimmed;
	return null;
}
