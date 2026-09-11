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
import type { HealthResponse } from '$lib/types';

/**
 * `GET /api/health?region=` - reports the effective CloudWatch Logs region and endpoint.
 *
 * The region is optional: when it is not supplied anywhere the SDK resolves it
 * from the ambient AWS configuration.
 */
export const GET = async ({ url }: RequestEvent): Promise<Response> => {
	const parsed = parseRegionParam(url.searchParams.get('region'));
	if (!parsed.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');

	const config = resolveAwsConfig(readEnv(), parsed.region);
	let client: CloudWatchLogsClient | undefined;
	try {
		client = createLogsClient(config);
		const region = await resolveEffectiveRegion(client, config);
		const body: HealthResponse = {
			ok: true,
			region,
			endpoint: config.endpoint,
			local: config.local,
			credentials: config.credentials,
		};
		return json(body);
	} catch (error) {
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	} finally {
		client?.destroy();
	}
};
