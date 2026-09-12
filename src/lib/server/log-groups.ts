import {
	DescribeLogGroupsCommand,
	type CloudWatchLogsClient,
	type LogGroup,
} from '@aws-sdk/client-cloudwatch-logs';
import type { ArchiveGroupRow } from '$lib/server/archive-sql';
import type { LogGroupSummary } from '$lib/types';

/** Page size requested from `DescribeLogGroups` (the API maximum). */
const PAGE_SIZE = 50;
const DEFAULT_LIMIT = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

/** Clamps the result limit into the supported 1..1000 range. */
function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.min(Math.max(Math.floor(limit), MIN_LIMIT), MAX_LIMIT);
}

/** Maps an SDK log group onto the wire type, omitting absent fields. */
function toSummary(group: LogGroup): LogGroupSummary {
	const summary: LogGroupSummary = { name: group.logGroupName ?? '' };
	if (group.arn !== undefined) summary.arn = group.arn;
	if (group.storedBytes !== undefined) summary.storedBytes = group.storedBytes;
	if (group.retentionInDays !== undefined) summary.retentionInDays = group.retentionInDays;
	if (group.creationTime !== undefined) summary.creationTime = group.creationTime;
	return summary;
}

/** Locale-independent name comparison for a stable sort. */
function byName(a: LogGroupSummary, b: LogGroupSummary): number {
	if (a.name === b.name) return 0;
	return a.name < b.name ? -1 : 1;
}

/**
 * Lists log groups for a region.
 *
 * Pages through `DescribeLogGroups` (50 per page, honouring `nextToken`),
 * filters by prefix on the client too because some emulators ignore
 * `logGroupNamePrefix`, de-duplicates by name, sorts by name and stops at
 * `limit` (default 200, clamped to 1..1000).
 */
export async function listLogGroups(
	client: CloudWatchLogsClient,
	options: { prefix?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<LogGroupSummary[]> {
	const prefix = options.prefix?.trim() ?? '';
	const limit = clampLimit(options.limit);
	const { signal } = options;
	const collected: LogGroupSummary[] = [];
	const seenNames = new Set<string>();
	let nextToken: string | undefined;

	do {
		if (signal?.aborted) break;
		const input: { limit: number; nextToken?: string; logGroupNamePrefix?: string } = {
			limit: PAGE_SIZE,
		};
		if (nextToken !== undefined) input.nextToken = nextToken;
		if (prefix.length > 0) input.logGroupNamePrefix = prefix;

		const response = await client.send(new DescribeLogGroupsCommand(input), {
			abortSignal: signal,
		});
		for (const group of response.logGroups ?? []) {
			const name = group.logGroupName;
			if (name === undefined || name.length === 0) continue;
			if (prefix.length > 0 && !name.startsWith(prefix)) continue;
			if (seenNames.has(name)) continue;
			seenNames.add(name);
			collected.push(toSummary(group));
			if (collected.length >= limit) break;
		}
		nextToken = response.nextToken;
	} while (nextToken !== undefined && nextToken.length > 0 && collected.length < limit);

	return collected.toSorted(byName);
}

/** Maps archived group rows onto the summary the group list renders. */
function archivedGroupSummaries(rows: readonly ArchiveGroupRow[]): LogGroupSummary[] {
	return rows.map((row) => {
		const summary: LogGroupSummary = { name: row.logGroup, archivedEvents: row.events };
		if (row.oldest !== null) summary.archivedOldest = row.oldest;
		if (row.newest !== null) summary.archivedNewest = row.newest;
		return summary;
	});
}

/**
 * Lists the log groups the local archive holds.
 *
 * The archive needs no credentials, so this works when CloudWatch is
 * unreachable. Groups are filtered by prefix and clamped to `limit` in process,
 * because the query already returns at most one row per group.
 */
export function listArchivedGroups(
	rows: readonly ArchiveGroupRow[],
	options: { prefix?: string; limit?: number } = {},
): LogGroupSummary[] {
	const prefix = options.prefix?.trim() ?? '';
	const limit = clampLimit(options.limit);
	const summaries = archivedGroupSummaries(rows).filter(
		(summary) => prefix.length === 0 || summary.name.startsWith(prefix),
	);
	return summaries.slice(0, limit).toSorted(byName);
}
