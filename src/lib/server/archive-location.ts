/** Account/region archive routing. Cached identities are for offline reads only. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createStsClient, parseRegionParam, resolveAwsConfig } from './aws';
import { getCallerIdentityWith } from './identity';

export type ArchiveSelection = {
	region?: string | null;
	/** Allows a previously verified account mapping to serve offline history. */
	readOnly?: boolean;
};

type Env = Record<string, string | undefined>;
type Identity = { account: string; region: string };

/** STS uses the same endpoint and credential configuration as the log routes. */
async function identify(env: Env, region: string | null): Promise<Identity> {
	const client = createStsClient(resolveAwsConfig(env, region));
	try {
		const effectiveRegion = region ?? (await client.config.region());
		const identity = await getCallerIdentityWith(client, { signal: AbortSignal.timeout(5000) });
		return { account: identity.account, region: effectiveRegion };
	} finally {
		client.destroy();
	}
}

function hash(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function valid(identity: Identity): boolean {
	return (
		typeof identity?.account === 'string' &&
		/^\d{12}$/.test(identity.account) &&
		typeof identity.region === 'string' &&
		!!identity.region &&
		parseRegionParam(identity.region).ok
	);
}

/** Resolves an archive path without guessing an account when AWS is unavailable. */
export class ArchiveLocator {
	#pending = new Map<string, Promise<Identity>>();
	#known = new Map<string, Identity>();
	constructor(private readonly lookup: typeof identify = identify) {}

	async locate(basePath: string, env: Env, selection: ArchiveSelection): Promise<string> {
		const config = resolveAwsConfig(env, selection.region);
		const root = env.WATCH_TAIL_ARCHIVE_DIR?.trim() || dirname(basePath);
		// Include credential-source selectors, never persist credentials themselves.
		const key = hash(
			JSON.stringify([
				config.endpoint,
				config.region,
				env.AWS_PROFILE || 'default',
				env.AWS_CONFIG_FILE,
				env.AWS_SHARED_CREDENTIALS_FILE,
				env.AWS_ROLE_ARN,
				env.AWS_WEB_IDENTITY_TOKEN_FILE,
				env.AWS_ACCESS_KEY_ID,
				env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
				env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
			]),
		);
		const cachePath = join(root, 'identities', `${key}.json`);
		let identity: Identity | undefined;
		if (selection.readOnly) {
			identity = this.#known.get(key);
			if (!identity) {
				try {
					const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Identity;
					if (valid(cached) && (!config.region || cached.region === config.region))
						identity = cached;
				} catch {
					/* No verified offline mapping yet. */
				}
			}
		}
		if (!identity) {
			let pending = this.#pending.get(key);
			if (!pending) {
				pending = this.lookup(env, config.region);
				this.#pending.set(key, pending);
			}
			try {
				identity = await pending;
				if (!valid(identity) || (config.region && config.region !== identity.region)) {
					throw new Error('AWS did not return a valid archive account and region');
				}
				this.#known.set(key, identity);
				try {
					mkdirSync(dirname(cachePath), { recursive: true });
					const temporary = `${cachePath}.${randomUUID()}.tmp`;
					writeFileSync(temporary, JSON.stringify(identity), { mode: 0o600 });
					renameSync(temporary, cachePath);
				} catch {
					/* Archiving still works if the offline mapping cannot be saved. */
				}
			} finally {
				this.#pending.delete(key);
			}
		}
		const namespace = config.endpoint ? join('endpoints', hash(config.endpoint)) : '';
		return join(root, namespace, identity.account, identity.region, 'archive.duckdb');
	}
}
