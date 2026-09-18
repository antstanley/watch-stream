import { effectiveLevel } from './log-buffer';
import { collectRequests, requestIdOf } from './request-groups';
import type { LogEventDto, SeriesPoint } from './types';

export type ChartSelection = {
	point: SeriesPoint;
	bucketMs: number;
	byRequest: boolean;
	fallbackGroup: string;
};

/** Resolve a plotted mark against the loaded events, before display filters. */
export function selectedChartEvents(
	lines: readonly LogEventDto[],
	selection: ChartSelection | null,
): Set<LogEventDto> {
	if (selection === null) return new Set();
	const { point, bucketMs, byRequest, fallbackGroup } = selection;
	const events = lines.filter((event) => (event.group ?? fallbackGroup) === point.group);
	if (point.requestId !== undefined) {
		return new Set(events.filter((event) => requestIdOf(event) === point.requestId));
	}
	const inBucket = (timestamp: number) => Math.floor(timestamp / bucketMs) * bucketMs === point.t;
	const matches = new Set<LogEventDto>();
	if (byRequest) {
		for (const request of collectRequests(events)) {
			if (inBucket(request.first) && request.level === point.level) {
				for (const { event } of request.events) matches.add(event);
			}
		}
	}
	for (const event of events) {
		if (byRequest && requestIdOf(event) !== null) continue;
		if (inBucket(event.timestamp) && (effectiveLevel(event) ?? 'unknown') === point.level) {
			matches.add(event);
		}
	}
	return matches;
}
