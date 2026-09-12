/**
 * The `group`/`groups` request parameters.
 *
 * A view can hold more than one log group, so the stream and series endpoints
 * accept either the single `group` parameter or a comma-separated `groups` list.
 * Parsing lives here so both endpoints agree on what a valid selection is.
 */

/** Most groups one request may hold. */
export const MAX_GROUPS = 10;

/** Message used when a request names no group at all. */
export const GROUP_PARAM_HINT = 'Query parameter "group" or "groups" is required';

/** Message used when a request names too many groups. */
export const TOO_MANY_GROUPS_HINT = `Too many groups: at most ${MAX_GROUPS} can be selected at once`;

export type GroupParams =
	| { ok: true; names: string[] }
	| { ok: false; code: string; message: string };

/**
 * Parses the group selection.
 *
 * `groups` may repeat the same name as `group`; duplicates are removed and the
 * order of the request is preserved, because it is the order the UI shows.
 */
export function parseGroupParams(
	group: string | null | undefined,
	groups: string | null | undefined,
): GroupParams {
	const names: string[] = [];
	const collect = (value: string | null | undefined): void => {
		if (typeof value !== 'string') return;
		for (const part of value.split(',')) {
			const name = part.trim();
			if (name.length === 0) continue;
			if (!names.includes(name)) names.push(name);
		}
	};
	collect(group);
	collect(groups);

	if (names.length === 0) return { ok: false, code: 'missing-group', message: GROUP_PARAM_HINT };
	if (names.length > MAX_GROUPS) {
		return { ok: false, code: 'too-many-groups', message: TOO_MANY_GROUPS_HINT };
	}
	return { ok: true, names };
}
