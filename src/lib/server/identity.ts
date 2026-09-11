/**
 * `sts:GetCallerIdentity` for the resolved configuration.
 *
 * This is the cheapest honest answer to "do these credentials work, and whose
 * are they?": one call, no permissions beyond the implicit
 * `sts:GetCallerIdentity`, and it returns the ARN to show the user.
 */
import { GetCallerIdentityCommand, type STSClient } from '@aws-sdk/client-sts';
import type { IdentityResponse } from '$lib/types';

/** Identity of the credentials in use, or `null` when STS cannot answer. */
export type CallerIdentity = Pick<IdentityResponse, 'arn' | 'account' | 'userId'>;

/** Reads the caller identity with an existing client. */
export async function getCallerIdentityWith(
	client: STSClient,
	options: { signal?: AbortSignal } = {},
): Promise<CallerIdentity> {
	const response = await client.send(new GetCallerIdentityCommand({}), {
		abortSignal: options.signal,
	});
	return {
		arn: response.Arn ?? '',
		account: response.Account ?? '',
		userId: response.UserId ?? '',
	};
}
