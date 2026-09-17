import { json, type RequestEvent } from '@sveltejs/kit';
import { apiError } from '$lib/server/api';
import { parseRegionParam, REGION_PARAM_HINT } from '$lib/server/aws';
import { getArchive } from '$lib/server/archive';
import { readEnv } from '$lib/server/env';
import type { ArchiveStatusResponse } from '$lib/types';

/**
 * `GET /api/archive` - what the local DuckDB archive holds.
 *
 * Never fails: an archive that is off by configuration, missing its optional
 * driver or unreadable answers 200 with `available: false` and the reason, so
 * the UI can hide the archive view instead of showing an error.
 */
export const GET = async ({ url }: Pick<RequestEvent, 'url'>): Promise<Response> => {
	const parsed = parseRegionParam(url.searchParams.get('region'));
	if (!parsed.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');
	const archive = await getArchive(readEnv(), { region: parsed.region, readOnly: true });
	const status = await archive.status();
	const body: ArchiveStatusResponse = {
		path: status.path,
		available: status.available,
		error: status.error,
		bytes: status.bytes,
		rows: status.totals.rows,
		groups: status.totals.groups,
		regions: status.totals.regions,
		oldest: status.totals.oldest,
		newest: status.totals.newest,
	};
	return json(body);
};
