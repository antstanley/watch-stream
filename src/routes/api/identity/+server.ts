import { json, type RequestEvent } from '@sveltejs/kit';
import { apiError } from '$lib/server/api';
import {
	REGION_PARAM_HINT,
	createStsClient,
	describeAwsError,
	parseRegionParam,
	resolveAwsConfig,
	resolveEffectiveRegion,
} from '$lib/server/aws';
import { readEnv } from '$lib/server/env';
import { getCallerIdentityWith } from '$lib/server/identity';
import type { IdentityResponse } from '$lib/types';

/**
 * `GET /api/identity` - whose credentials are these?
 *
 * `sts:GetCallerIdentity` needs no permissions of its own, so a 200 here means
 * the ambient credentials are usable, and the ARN says which account they belong
 * to. The CLI uses it to avoid offering a login for a profile that already
 * works, and to report what it signed in as.
 *
 * The region is optional, like everywhere else: without one the SDK resolves it
 * from the ambient configuration.
 */
export const GET = async ({ url, request }: RequestEvent): Promise<Response> => {
	const parsedRegion = parseRegionParam(url.searchParams.get('region'));
	if (!parsedRegion.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');

	const env = readEnv();
	const config = resolveAwsConfig(env, parsedRegion.region, 'sts');

	let client;
	let region: string;
	try {
		client = createStsClient(config);
		region = await resolveEffectiveRegion(client, config);
	} catch (error) {
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	}

	try {
		const identity = await getCallerIdentityWith(client, { signal: request.signal });
		const body: IdentityResponse = {
			...identity,
			region,
			endpoint: config.endpoint,
		};
		return json(body);
	} catch (error) {
		if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
			return apiError(499, 'The client closed the request before STS replied', 'aborted');
		}
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	} finally {
		client.destroy();
	}
};
