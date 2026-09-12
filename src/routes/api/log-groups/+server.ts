import { json, type RequestEvent } from '@sveltejs/kit';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { apiError } from '$lib/server/api';
import {
	REGION_PARAM_HINT,
	createLogsClient,
	describeAwsError,
	parseRegionParam,
	resolveAwsConfig,
	resolveEffectiveRegion,
} from '$lib/server/aws';
import { getArchive } from '$lib/server/archive';
import { readEnv } from '$lib/server/env';
import { listArchivedGroups, listLogGroups } from '$lib/server/log-groups';
import { SOURCE_PARAM_HINT, parseSourceParam } from '$lib/server/source';
import type { LogGroupsResponse } from '$lib/types';

const MAX_LIMIT = 1000;

/**
 * `GET /api/log-groups?region=&prefix=&limit=&source=` - lists log groups.
 *
 * `source=cloudwatch` (the default) asks CloudWatch Logs for the region; the
 * region is optional there, because the SDK resolves it from the ambient AWS
 * configuration. `source=archive` lists what the local DuckDB file holds for
 * that region and needs no credentials at all. `request.signal` is forwarded to
 * the SDK so a disconnected client cancels the pagination loop.
 */
export const GET = async ({ url, request }: RequestEvent): Promise<Response> => {
	const parsedRegion = parseRegionParam(url.searchParams.get('region'));
	if (!parsedRegion.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');

	const env = readEnv();
	const limitRaw = url.searchParams.get('limit')?.trim() ?? '';
	let limit: number | undefined;
	if (limitRaw.length > 0) {
		const parsed = Number(limitRaw);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
			return apiError(
				400,
				`Invalid limit: expected an integer between 1 and ${MAX_LIMIT}`,
				'invalid-limit',
			);
		}
		limit = parsed;
	} else {
		// `WATCH_STREAM_LIMIT` is a default only: a bad value is ignored, not a 400.
		const configured = Number((env.WATCH_STREAM_LIMIT ?? '').trim());
		if (Number.isInteger(configured) && configured >= 1 && configured <= MAX_LIMIT) {
			limit = configured;
		}
	}

	const prefix = url.searchParams.get('prefix')?.trim();
	const source = parseSourceParam(url.searchParams.get('source'));
	if (source === null) return apiError(400, SOURCE_PARAM_HINT, 'invalid-source');
	const config = resolveAwsConfig(env, parsedRegion.region);

	if (source === 'archive') {
		const archive = await getArchive(env);
		const groups = listArchivedGroups(await archive.groups(config.region), { prefix, limit });
		const body: LogGroupsResponse = {
			region: config.region ?? '',
			endpoint: null,
			source,
			groups,
		};
		return json(body);
	}

	let client: CloudWatchLogsClient | undefined;

	try {
		client = createLogsClient(config);
		const region = await resolveEffectiveRegion(client, config);
		const groups = await listLogGroups(client, {
			prefix: prefix !== undefined && prefix.length > 0 ? prefix : undefined,
			limit,
			signal: request.signal,
		});
		const body: LogGroupsResponse = { region, endpoint: config.endpoint, source, groups };
		return json(body);
	} catch (error) {
		if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
			return apiError(
				499,
				'The client closed the request before CloudWatch Logs replied',
				'aborted',
			);
		}
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	} finally {
		client?.destroy();
	}
};
