<script lang="ts">
	/**
	 * The chart panel above the log view: a header that is always cheap to render
	 * (title, totals, per-level legend) and the chart below it, loaded on demand.
	 *
	 * The charting library is imported dynamically and only once the panel is open,
	 * so layerchart never delays the first paint of the log view. The header stays
	 * available while the chart chunk is still loading, and the whole panel
	 * collapses to that header so a user who does not want the chart can reclaim
	 * the space - the choice is remembered.
	 */
	import { formatCount } from '$lib/format';
	import { SERIES_LEVEL_COLOR, groupByLevel } from '$lib/series-buckets';
	import { STORAGE_KEYS } from '$lib/resize';
	import type { SeriesPoint } from '$lib/types';
	import type { BrushRange } from './EventScatter.svelte';

	/** Props the lazily loaded chart takes. */
	type ChartProps = {
		points: SeriesPoint[];
		from: number;
		to: number;
		height: number;
		onBrush: (range: BrushRange | null) => void;
	};

	/** The chart component, as its module exports it. */
	type ChartComponent = (typeof import('./EventScatter.svelte'))['default'];

	/** Fetches the chart module; injectable so tests need no chunk fetch. */
	type ChartLoader = () => Promise<{ default: ChartComponent }>;

	/**
	 * The real loader: a dynamic import, which is what keeps layerchart out of the
	 * initial bundle. It only runs in the browser, and only once the panel is open.
	 */
	const loadChartModule: ChartLoader = () => import('./EventScatter.svelte');

	type Props = {
		/** Bucketed counts for the window. */
		points?: SeriesPoint[];
		/** Inclusive start of the window, epoch ms. */
		from?: number;
		/** Inclusive end of the window, epoch ms. */
		to?: number;
		/** Bucket width in ms, shown in the summary. */
		bucketMs?: number;
		/** Log groups the points cover, for the summary. */
		groups?: string[];
		/** True while the counts are being fetched. */
		loading?: boolean;
		/** Called with the brushed range when the drag ends, or `null` on clear. */
		onBrush?: (range: BrushRange | null) => void;
		/** Chart height in px. */
		height?: number;
		/** Start open, which is also what the first visit uses. */
		open?: boolean;
		/** Chart module loader; defaults to the dynamic import. */
		loadChart?: ChartLoader;
	};

	let {
		points = [],
		from = 0,
		to = 0,
		bucketMs = 0,
		groups = [],
		loading = false,
		onBrush,
		height = 200,
		open = true,
		loadChart = loadChartModule,
	}: Props = $props();

	/**
	 * Whether the chart is expanded. `null` means "nobody has decided yet", so the
	 * `open` prop applies until the stored preference is read or the user toggles.
	 */
	let expandedChoice = $state<boolean | null>(null);
	let expanded = $derived(expandedChoice ?? open);
	/** The chart component, once its chunk has arrived. */
	let Chart = $state<ChartComponent | null>(null);
	/** True when the chunk could not be loaded, so the panel can say so. */
	let chartError = $state(false);
	/** Range the pointer is sweeping right now, shown as a preview until release. */
	let brushPreview = $state<BrushRange | null>(null);
	/**
	 * Bumped by {@link reset} to remount the chart. Remounting is how the brush is
	 * cleared without holding an imperative handle on a lazily loaded component.
	 */
	let chartKey = $state(0);

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		const stored = localStorage.getItem(STORAGE_KEYS.chartOpen);
		if (stored === '0') expandedChoice = false;
		if (stored === '1') expandedChoice = true;
	});

	/**
	 * Fetches the chart chunk the first time the panel is open.
	 *
	 * The import is dynamic on purpose: it keeps layerchart out of the initial
	 * bundle, and it only runs in the browser, where the chart can render.
	 */
	$effect(() => {
		if (!expanded || Chart !== null || chartError) return;
		let cancelled = false;
		void loadChart()
			.then((module) => {
				if (!cancelled) Chart = module.default as unknown as ChartComponent;
				return undefined;
			})
			.catch(() => {
				if (!cancelled) chartError = true;
			});
		return () => {
			cancelled = true;
		};
	});

	/** Collapses or expands the panel and remembers the choice. */
	function toggle(): void {
		expandedChoice = !expanded;
		try {
			localStorage?.setItem(STORAGE_KEYS.chartOpen, expanded ? '1' : '0');
		} catch {
			// A preference is best effort: private mode, quota, no storage.
		}
	}

	/** Wall-clock label for a brush preview. */
	function formatClock(ms: number): string {
		return new Date(ms).toISOString().slice(11, 19);
	}

	/** Totals and labels per level, in severity order. */
	let levelGroups = $derived(groupByLevel(points));
	/** Total events drawn. */
	let totalEvents = $derived(levelGroups.reduce((sum, entry) => sum + entry.events, 0));
	/** Buckets drawn. */
	let bucketCount = $derived(new Set(points.map((point) => point.t)).size);
	/** True when there is something to draw. */
	let hasPoints = $derived(points.length > 0);

	/** Clears the brush, for the host's Reset zoom control. */
	export function reset(): void {
		chartKey += 1;
		onBrush?.(null);
	}
</script>

<section
	class="flex min-w-0 flex-col gap-1 rounded-lg border border-neutral-800 bg-neutral-950/60 p-2"
	data-testid="event-scatter"
	aria-label="Events over time"
>
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[0.6875rem]">
		<button
			type="button"
			onclick={toggle}
			aria-expanded={expanded}
			title={expanded ? 'Hide the chart' : 'Show the chart'}
			data-testid="scatter-toggle"
			class="flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-0.5 font-semibold uppercase tracking-wider text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
		>
			<span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
			Events over time
		</button>
		<span class="text-neutral-400" data-testid="scatter-summary">
			{formatCount(totalEvents)} events in {formatCount(bucketCount)} buckets
		</span>
		{#if groups.length > 1}
			<span class="text-neutral-500" data-testid="scatter-groups">
				across {groups.length} groups
			</span>
		{/if}
		{#each levelGroups as entry (entry.level)}
			<span
				class="flex items-center gap-1 text-neutral-400"
				data-testid="scatter-legend-{entry.level}"
			>
				<span
					class="inline-block h-2 w-2 rounded-full"
					style="background-color: {SERIES_LEVEL_COLOR[entry.level]}"
				></span>
				{entry.label}
				<span class="text-neutral-500">{formatCount(entry.events)}</span>
			</span>
		{/each}
		{#if loading && expanded}
			<span class="text-amber-300" data-testid="scatter-loading">counting…</span>
		{/if}
		{#if expanded}
			{#if brushPreview !== null}
				<span class="ml-auto text-sky-300" data-testid="scatter-brush-preview">
					release to zoom to {formatClock(brushPreview.from)} – {formatClock(brushPreview.to)}
				</span>
			{:else}
				<span class="ml-auto text-neutral-500" data-testid="scatter-hint">
					drag to zoom · click to clear
				</span>
			{/if}
		{/if}
	</div>

	{#if expanded}
		{#if chartError}
			<p class="px-1 py-4 text-xs text-amber-300" data-testid="scatter-error">
				The chart could not be loaded. The log view is unaffected.
			</p>
		{:else if hasPoints}
			{#if Chart !== null}
				<!-- Remounted on reset, which is what clears a brush. -->
				{#key chartKey}
					<Chart
						{points}
						{from}
						{to}
						{height}
						onBrush={(range) => {
							brushPreview = null;
							onBrush?.(range);
						}}
						onBrushPreview={(range) => (brushPreview = range)}
					/>
				{/key}
			{:else}
				<!-- Placeholder while the chunk is in flight, so the panel does not jump. -->
				<div
					class="w-full animate-pulse rounded bg-neutral-900/60"
					style="height: {height}px"
				></div>
			{/if}
		{:else if !loading}
			<p class="px-1 py-6 text-xs text-neutral-500" data-testid="scatter-empty">
				No events in this window yet.
			</p>
		{/if}
	{/if}
</section>
