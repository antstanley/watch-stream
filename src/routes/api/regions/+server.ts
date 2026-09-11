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
import { readEnv } from '$lib/server/env';
import { resolveRegions } from '$lib/server/regions';
import type { RegionsResponse } from '$lib/types';

/**
 * `GET /api/regions?region=` - region list for the picker plus the effective region.
 *
 * The effective region becomes `defaultRegion`, so a region resolved from the
 * ambient AWS configuration is selected by default.
 */
export const GET = async ({ url }: RequestEvent): Promise<Response> => {
	const parsed = parseRegionParam(url.searchParams.get('region'));
	if (!parsed.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');

	const env = readEnv();
	const config = resolveAwsConfig(env, parsed.region);
	let client: CloudWatchLogsClient | undefined;
	try {
		client = createLogsClient(config);
		const effectiveRegion = await resolveEffectiveRegion(client, config);
		const { regions, defaultRegion } = resolveRegions(env, effectiveRegion);
		const body: RegionsResponse = { regions, defaultRegion, endpoint: config.endpoint };
		return json(body);
	} catch (error) {
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	} finally {
		client?.destroy();
	}
};
