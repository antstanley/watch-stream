<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import EndpointBadge from '$lib/components/EndpointBadge.svelte';
	import ColumnResizer from '$lib/components/ColumnResizer.svelte';
	import RangeControls from '$lib/components/RangeControls.svelte';
	import LogGroupList from '$lib/components/LogGroupList.svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import RegionSelect from '$lib/components/RegionSelect.svelte';
	import {
		DEFAULT_REGIONS,
		describeGroupsError,
		fetchHealth,
		fetchLogGroups,
		fetchRegions,
	} from '$lib/groups-client';
	import { LogStream } from '$lib/log-stream.svelte';
	import type { LogMode } from '$lib/time-range';
	import { SIDEBAR_WIDTH, STORAGE_KEYS, clampWidth, parseStoredWidth, remToPx } from '$lib/resize';
	import type { HealthResponse, LogGroupSummary } from '$lib/types';

	/** Owns the SSE connection; the page only wires it to the UI. */
	const stream = new LogStream();

	/** Region picker state. Seeded from the URL so a shared link restores the view. */
	let region = $state(page.url.searchParams.get('region') ?? '');
	/** Tail mode and historic window, seeded from the URL. */
	let mode = $state<LogMode>(
		page.url.searchParams.get('mode') === 'historic' ? 'historic' : 'live',
	);
	let range = $state(page.url.searchParams.get('range') ?? '15m');
	let windowFrom = $state<number | null>(parseUrlEpoch(page.url.searchParams.get('from')));
	let windowTo = $state<number | null>(parseUrlEpoch(page.url.searchParams.get('to')));
	let rangeLoading = $state(false);
	let regions = $state<string[]>([...DEFAULT_REGIONS]);
	let groups = $state<LogGroupSummary[]>([]);
	let groupsLoading = $state(false);
	let groupsError = $state<string | null>(null);
	let health = $state<HealthResponse | null>(null);
	let endpoint = $state<string | null>(null);
	let bootError = $state<string | null>(null);
	let filter = $state('');
	let autoScroll = $state(true);

	/** Group currently being tailed, or `null`. */
	let selectedGroup = $derived(stream.target?.group ?? null);

	/** Viewport width, tracked so the sidebar clamp can use a percentage ceiling. */
	let viewportWidth = $state(0);
	/** Sidebar width in pixels; the layout default is 22rem. */
	let sidebarPx = $state(remToPx(SIDEBAR_WIDTH.defaultRem));

	/** Largest sidebar width allowed: 44vw, but never below the minimum. */
	let sidebarMaxPx = $derived(
		viewportWidth === 0
			? remToPx(SIDEBAR_WIDTH.defaultRem)
			: Math.max(remToPx(SIDEBAR_WIDTH.minRem), (viewportWidth * SIDEBAR_WIDTH.maxVw) / 100),
	);
	let sidebarMinPx = remToPx(SIDEBAR_WIDTH.minRem);
	let sidebarStyle = $derived(`width: min(${sidebarPx}px, ${SIDEBAR_WIDTH.maxVw}vw)`);

	/** Reads a raw preference, tolerating disabled or throwing storage. */
	function readPref(key: string): string | null {
		try {
			if (typeof localStorage === 'undefined') return null;
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	/** Persists the sidebar width; failures are ignored (private mode, quota). */
	function saveSidebarWidth(): void {
		try {
			if (typeof localStorage === 'undefined') return;
			localStorage.setItem(STORAGE_KEYS.sidebarWidth, String(Math.round(sidebarPx)));
		} catch {
			// Preferences are best-effort only.
		}
	}

	onMount(() => {
		void bootstrap();
		const clampToViewport = (): void => {
			viewportWidth = window.innerWidth;
		};
		clampToViewport();
		sidebarPx = clampWidth(
			parseStoredWidth(
				readPref(STORAGE_KEYS.sidebarWidth),
				remToPx(SIDEBAR_WIDTH.defaultRem),
				remToPx(SIDEBAR_WIDTH.minRem),
				(window.innerWidth * SIDEBAR_WIDTH.maxVw) / 100,
			),
			remToPx(SIDEBAR_WIDTH.minRem),
			Math.max(remToPx(SIDEBAR_WIDTH.minRem), (window.innerWidth * SIDEBAR_WIDTH.maxVw) / 100),
		);
		window.addEventListener('resize', clampToViewport);
		return () => {
			stream.stop();
			window.removeEventListener('resize', clampToViewport);
		};
	});

	/** Loads metadata, then groups, then auto-selects the group from the URL. */
	async function bootstrap(): Promise<void> {
		const requestedGroup = page.url.searchParams.get('group');
		await loadMeta();
		await loadGroups(region);
		if (requestedGroup !== null && requestedGroup !== '') {
			rangeLoading = mode === 'historic';
			selectGroup(requestedGroup);
		} else {
			syncUrl(region, null);
		}
	}

	/** Loads the region list and health, falling back to the built-in region list. */
	async function loadMeta(): Promise<void> {
		try {
			const [regionsResponse, healthResponse] = await Promise.all([fetchRegions(), fetchHealth()]);
			if (regionsResponse.regions.length > 0) regions = regionsResponse.regions;
			if (region === '') {
				region = regionsResponse.defaultRegion || regions[0] || DEFAULT_REGIONS[0];
			}
			health = healthResponse;
			endpoint = healthResponse.endpoint;
		} catch (error) {
			bootError = `Could not reach the watch-stream API. ${failureText(error)}`;
			if (region === '') region = DEFAULT_REGIONS[0];
		}
	}

	/** Loads the log groups of a region; a newer region change wins the race. */
	async function loadGroups(target: string): Promise<void> {
		groupsLoading = true;
		groupsError = null;
		try {
			const response = await fetchLogGroups({ region: target });
			if (target !== region) return;
			if (response.endpoint !== null) endpoint = response.endpoint;
			groups = response.groups;
		} catch (error) {
			if (target !== region) return;
			groups = [];
			groupsError = describeGroupsError(target, error);
		} finally {
			if (target === region) groupsLoading = false;
		}
	}

	/** Parses an epoch-millisecond URL parameter, or `null`. */
	function parseUrlEpoch(value: string | null): number | null {
		if (value === null || value.trim() === '') return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	/** The window the current mode asks for. */
	function windowParams(): {
		mode: LogMode;
		range?: string;
		from?: number;
		to?: number;
	} {
		if (mode === 'live') return { mode: 'live' };
		if (range === '' && windowFrom !== null && windowTo !== null) {
			return { mode: 'historic', from: windowFrom, to: windowTo };
		}
		return { mode: 'historic', range: range === '' ? '15m' : range };
	}

	/** Starts tailing a group with the active mode and window. */
	function selectGroup(name: string): void {
		if (region === '' || name === '') return;
		stream.start({ region, group: name, ...windowParams() });
		syncUrl(region, name);
	}

	/** Applies a mode or range change: restarts the stream and mirrors it into the URL. */
	function applyRange(payload: {
		mode: LogMode;
		range: string;
		from: number | null;
		to: number | null;
	}): void {
		mode = payload.mode;
		range = payload.range;
		windowFrom = payload.from;
		windowTo = payload.to;
		syncUrl(region, selectedGroup);
		if (selectedGroup === null) return;
		rangeLoading = payload.mode === 'historic';
		stream.start({ region, group: selectedGroup, ...windowParams() });
	}

	/** Switches region: stops the stream, clears the list and reloads the groups. */
	function changeRegion(next: string): void {
		if (next === '' || next === region) return;
		region = next;
		stream.stop();
		groups = [];
		syncUrl(next, null);
		void loadGroups(next);
	}

	/** Reloads the groups of the active region. */
	function refreshGroups(): void {
		void loadGroups(region);
	}

	/** Replaces the view parameters in the address bar. */
	function syncUrl(nextRegion: string, nextGroup: string | null): void {
		const url = new URL(page.url);
		if (nextRegion === '') url.searchParams.delete('region');
		else url.searchParams.set('region', nextRegion);
		if (nextGroup === null || nextGroup === '') url.searchParams.delete('group');
		else url.searchParams.set('group', nextGroup);

		if (mode === 'live') {
			url.searchParams.delete('mode');
			url.searchParams.delete('range');
			url.searchParams.delete('from');
			url.searchParams.delete('to');
		} else {
			url.searchParams.set('mode', 'historic');
			url.searchParams.delete('from');
			url.searchParams.delete('to');
			url.searchParams.delete('range');
			if (range === '' && windowFrom !== null && windowTo !== null) {
				url.searchParams.set('from', String(windowFrom));
				url.searchParams.set('to', String(windowTo));
			} else {
				url.searchParams.set('range', range === '' ? '15m' : range);
			}
		}
		if (url.href !== page.url.href) replaceState(url, {});
	}

	/** Clears the loading hint once the server reports its window. */
	$effect(() => {
		if (stream.ready !== null || stream.status === 'error') rangeLoading = false;
	});

	/** Short description of an unknown failure. */
	function failureText(error: unknown): string {
		return error instanceof Error && error.message !== '' ? error.message : String(error);
	}
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
	<span class="text-[0.6875rem] font-semibold uppercase tracking-wider text-neutral-500">
		Watching
	</span>
	<span
		class="max-w-[22rem] truncate rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-200"
	>
		{selectedGroup ?? 'no group selected'}
	</span>
	<span class="text-xs text-neutral-500">in</span>
	<span class="font-mono text-xs text-neutral-300"
		>{region === '' ? 'resolving region…' : region}</span
	>
	<EndpointBadge {endpoint} credentials={health?.credentials ?? null} />
	{#if health !== null && health.ok}
		<span class="text-xs text-emerald-400/80">API ok</span>
	{/if}
</div>

{#if bootError !== null}
	<p
		role="alert"
		data-testid="boot-error"
		class="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs leading-5 text-red-300"
	>
		{bootError}
	</p>
{/if}

<RangeControls
	{mode}
	{range}
	from={windowFrom}
	to={windowTo}
	loading={rangeLoading}
	disabled={selectedGroup === null}
	onApply={applyRange}
/>

<div class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:flex-row">
	<div
		class="flex min-h-0 w-full flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 lg:shrink-0"
		style={sidebarStyle}
		data-testid="sidebar"
	>
		<RegionSelect {regions} value={region} onchange={changeRegion} />
		<LogGroupList
			{groups}
			{region}
			selected={selectedGroup}
			loading={groupsLoading}
			error={groupsError}
			onSelect={selectGroup}
			onRefresh={refreshGroups}
		/>
	</div>

	<ColumnResizer
		label="Resize group list"
		width={sidebarPx}
		min={sidebarMinPx}
		max={sidebarMaxPx}
		testId="sidebar-resizer"
		onChange={(next) => (sidebarPx = next)}
		onCommit={() => saveSidebarWidth()}
		class="hidden lg:block lg:w-2"
	/>

	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		<LogViewer
			lines={stream.lines}
			status={stream.status}
			error={stream.lastError}
			{mode}
			ready={stream.ready}
			endReason={stream.endReason}
			{region}
			group={selectedGroup}
			{filter}
			paused={stream.paused}
			{autoScroll}
			pendingCount={stream.pendingCount}
			droppedCount={stream.droppedCount}
			receivedCount={stream.receivedCount}
			onFilterChange={(value) => (filter = value)}
			onPauseToggle={() => stream.togglePause()}
			onClear={() => stream.clear()}
			onAutoScrollToggle={() => (autoScroll = !autoScroll)}
		/>
	</div>
</div>
