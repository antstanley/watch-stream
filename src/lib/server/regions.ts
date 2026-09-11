import { REGION_CODES } from '$lib/regions';
import { FALLBACK_REGION, resolveAwsConfig } from './aws';

/**
 * Region list used when `WATCH_STREAM_REGIONS` is unset.
 *
 * Every AWS region that publishes CloudWatch Logs endpoints, including
 * `af-south-1`; see `$lib/regions`.
 */
export const FALLBACK_REGIONS: string[] = [...REGION_CODES];

/** Splits a comma-separated region list, trimming and dropping blanks. */
function parseRegionList(value: string | undefined): string[] {
	if (typeof value !== 'string') return [];
	const regions: string[] = [];
	for (const part of value.split(',')) {
		const region = part.trim();
		if (region.length > 0 && !regions.includes(region)) regions.push(region);
	}
	return regions;
}

/** Trims a value and treats blank strings as absent. */
function normalize(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves the region list for the picker plus the default region.
 *
 * `defaultRegion` is the explicit environment region when set, otherwise
 * `effectiveRegion` (usually the region the SDK resolved from the ambient AWS
 * configuration), otherwise `us-east-1`. The list comes from
 * `WATCH_STREAM_REGIONS` when set, otherwise from {@link FALLBACK_REGIONS}, and
 * the default region is always present: it is prepended when missing, keeping
 * the remaining order de-duplicated.
 */
export function resolveRegions(
	env: Record<string, string | undefined>,
	effectiveRegion?: string | null,
): { regions: string[]; defaultRegion: string } {
	const { region: envRegion } = resolveAwsConfig(env);
	const defaultRegion = envRegion ?? normalize(effectiveRegion) ?? FALLBACK_REGION;
	const configured = parseRegionList(env.WATCH_STREAM_REGIONS);
	const regions = configured.length > 0 ? configured : [...FALLBACK_REGIONS];
	if (!regions.includes(defaultRegion)) regions.unshift(defaultRegion);
	return { regions, defaultRegion };
}
