import { json, type RequestEvent } from '@sveltejs/kit';
import { apiError } from '$lib/server/api';
import { getArchive } from '$lib/server/archive';
import { REGION_PARAM_HINT, parseRegionParam, resolveAwsConfig } from '$lib/server/aws';
import { readEnv } from '$lib/server/env';
import { resolveWindow } from '$lib/server/filter';
import { parseGroupParams } from '$lib/server/group-params';
import { LEVEL_PARAM_HINT, parseLevelParam } from '$lib/server/level-filter';
import {
	GROUP_BY_PARAM_HINT,
	SERIES_SOURCE_HINT,
	parseBucketParam,
	parseGroupByParam,
	readSeries,
} from '$lib/server/series';
import { SOURCE_PARAM_HINT, parseSourceParam } from '$lib/server/source';

/**
 * `GET /api/series` - counts per time bucket, per group and level.
 *
 * This is the chart's data. Only the archive can answer it: DuckDB counts a
 * whole window in one statement, while CloudWatch Logs has no aggregate API, so
 * the UI buckets the events it already streamed for a live or CloudWatch view.
 * `by=request` counts requests instead of lines, placing each request at its
 * first line and colouring it by its most critical level.
 *
 * The window is not clamped to CloudWatch's 14 days, because the archive keeps
 * what CloudWatch has already dropped.
 */
export const GET = async ({ url }: RequestEvent): Promise<Response> => {
	const parsedRegion = parseRegionParam(url.searchParams.get('region'));
	if (!parsedRegion.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');

	const source = parseSourceParam(url.searchParams.get('source'));
	if (source === null) return apiError(400, SOURCE_PARAM_HINT, 'invalid-source');
	if (source !== 'archive') return apiError(400, SERIES_SOURCE_HINT, 'unsupported-source');

	const groups = parseGroupParams(url.searchParams.get('group'), url.searchParams.get('groups'));
	if (!groups.ok) return apiError(400, groups.message, groups.code);

	const levels = parseLevelParam(url.searchParams.get('level'));
	if (levels === undefined) return apiError(400, LEVEL_PARAM_HINT, 'invalid-level');

	const by = parseGroupByParam(url.searchParams.get('by'));
	if (by === undefined) return apiError(400, GROUP_BY_PARAM_HINT, 'invalid-group-by');

	const env = readEnv();
	const config = resolveAwsConfig(env, parsedRegion.region);
	const region = config.region ?? '';
	if (region === '') {
		return apiError(
			400,
			'Query parameter "region" is required when source=archive',
			'missing-region-param',
		);
	}

	const window = resolveWindow(
		{
			mode: 'historic',
			range: url.searchParams.get('range'),
			from: url.searchParams.get('from'),
			to: url.searchParams.get('to'),
			now: Date.now(),
		},
		{ maxLookbackMs: null },
	);
	if (!window.ok) return apiError(400, window.message, window.code);
	const endTime = window.endTime ?? Date.now();

	const archive = await getArchive(env, { region: config.region, readOnly: true });
	const series = await readSeries({
		archive,
		region,
		logGroups: groups.names,
		from: window.startTime,
		to: endTime,
		levels,
		by,
		bucketMs: parseBucketParam(url.searchParams.get('bucket')),
	});
	// An unavailable archive answers an empty series: the chart says "nothing
	// archived yet" instead of failing, and /api/archive explains why.
	return json(series);
};
