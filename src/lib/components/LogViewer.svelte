<script lang="ts">
	import { onMount } from 'svelte';
	import ColumnResizer from './ColumnResizer.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import { formatCount, formatTime, formatTimestamp } from '$lib/format';
	import { describeStreamError } from '$lib/groups-client';
	import { detectLevel, eventKey, filterEvents, levelColorClass } from '$lib/log-buffer';
	import type { LogLevel } from '$lib/log-buffer';
	import { formatLogMessage, tokenizeJson } from '$lib/log-format';
	import type { JsonToken } from '$lib/log-format';
	import { PREFIX_WIDTH, STORAGE_KEYS, parseStoredWidth, pxToRem, remToPx } from '$lib/resize';
	import { describeWindow } from '$lib/time-range';
	import type { LogMode } from '$lib/time-range';
	import type {
		LogEventDto,
		StreamErrorPayload,
		StreamReadyPayload,
		StreamState,
	} from '$lib/types';

	type Props = {
		/** Lines held by the client buffer, oldest first. */
		lines?: LogEventDto[];
		/** Connection status. */
		status?: StreamState;
		/** Last stream error, or `null`. */
		error?: StreamErrorPayload | null;
		/** Active region, used for error and empty-state context. */
		region?: string;
		/** Group being tailed, or `null` when nothing is selected. */
		group?: string | null;
		/** Client-side text filter, controlled by the parent. */
		filter?: string;
		/** True while the visible buffer is frozen. */
		paused?: boolean;
		/** True when new lines scroll the view. */
		autoScroll?: boolean;
		/** Lines held back while paused. */
		pendingCount?: number;
		/** Lines dropped by the cap. */
		droppedCount?: number;
		/** Total events received since the last reset. */
		receivedCount?: number;
		/** Active tail mode, used for the window chip. */
		mode?: LogMode;
		/** Last `ready` payload, which describes the window the server is scanning. */
		ready?: StreamReadyPayload | null;
		/** Reason the server ended the stream, for example `window-complete`. */
		endReason?: string | null;
		onFilterChange?: (value: string) => void;
		onPauseToggle?: () => void;
		onClear?: () => void;
		onAutoScrollToggle?: () => void;
	};

	let {
		lines = [],
		status = 'idle',
		error = null,
		region = '',
		group = null,
		filter = '',
		paused = false,
		autoScroll = true,
		pendingCount = 0,
		droppedCount = 0,
		receivedCount = 0,
		mode = 'live',
		ready = null,
		endReason = null,
		onFilterChange,
		onPauseToggle,
		onClear,
		onAutoScrollToggle,
	}: Props = $props();

	const TIMESTAMP_COLUMN_PX = remToPx(7.5);
	const ROW_PADDING_PX = remToPx(0.75);
	const ROW_GAP_PX = remToPx(0.5);
	const PREFIX_MIN_PX = remToPx(PREFIX_WIDTH.minRem);
	const PREFIX_MAX_PX = remToPx(PREFIX_WIDTH.maxRem);
	const PREFIX_DEFAULT_PX = remToPx(PREFIX_WIDTH.defaultRem);

	/** Reads a raw preference, tolerating disabled or throwing storage. */
	function readPref(key: string): string | null {
		try {
			if (typeof localStorage === 'undefined') return null;
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	/** Persists a preference; failures are ignored (private mode, quota). */
	function writePref(key: string, value: string): void {
		try {
			if (typeof localStorage === 'undefined') return;
			localStorage.setItem(key, value);
		} catch {
			// Preferences are best-effort only.
		}
	}

	/** View preferences, restored in `onMount` so SSR output stays deterministic. */
	let wrapLines = $state(false);
	let jsonView = $state(true);
	let prefixPx = $state(PREFIX_DEFAULT_PX);

	onMount(() => {
		wrapLines = readPref(STORAGE_KEYS.wrap) === 'true';
		jsonView = readPref(STORAGE_KEYS.jsonView) !== 'false';
		prefixPx = parseStoredWidth(
			readPref(STORAGE_KEYS.prefixWidth),
			PREFIX_DEFAULT_PX,
			PREFIX_MIN_PX,
			PREFIX_MAX_PX,
		);
	});

	/** One rendered row, pre-formatted so the template stays declarative. */
	type Row = {
		key: string;
		time: string;
		timestamp: string;
		streamName: string | undefined;
		message: string;
		tokens: JsonToken[] | null;
		level: LogLevel;
		levelClass: string;
	};

	/** Lines matching the client-side filter. */
	let visible = $derived(filterEvents(lines, filter));
	/** Presentation rows for the visible lines. */
	let rows: Row[] = $derived(
		visible.map((event, index) => {
			const level = detectLevel(event.message);
			const formatted = formatLogMessage(event.message, { prettyJson: jsonView });
			return {
				key: eventKey(event, index),
				time: formatTime(event.timestamp),
				timestamp: formatTimestamp(event.timestamp),
				streamName: event.streamName,
				message: formatted.text,
				tokens: jsonView && formatted.isJson ? tokenizeJson(formatted.text) : null,
				level,
				levelClass: levelColorClass(level),
			};
		}),
	);

	let scroller: HTMLElement | null = $state(null);

	/** Keeps the newest line in view while auto-scroll is on (vertical only). */
	$effect(() => {
		// Reading the row count keeps this effect in sync with every appended batch.
		const total = rows.length;
		if (!autoScroll || scroller === null || total === 0) return;
		scroller.scrollTop = scroller.scrollHeight;
	});

	/** Error text with the group and region context. */
	let errorText = $derived(
		error === null ? null : describeStreamError(region, group, error.message),
	);
	/** Body text when there is nothing to render. */
	let emptyText = $derived(
		group === null || group === ''
			? 'Select a log group to start tailing.'
			: filter.trim() === ''
				? `Waiting for events from ${group}\u2026`
				: 'No lines match the filter.',
	);
	/** Auto-scroll button colour. */
	let autoScrollTone = $derived(autoScroll ? 'text-sky-300' : 'text-neutral-400');
	/** Chip describing the active window. */
	let windowSummary = $derived(describeWindow(ready, Date.now()));
	/** True when a historic scan finished on its own. */
	let windowComplete = $derived(mode === 'historic' && endReason === 'window-complete');
	/** Wrap toggle colour. */
	let wrapTone = $derived(wrapLines ? 'text-sky-300' : 'text-neutral-400');
	/** JSON toggle colour. */
	let jsonTone = $derived(jsonView ? 'text-sky-300' : 'text-neutral-400');
	/** Rows fill the window when wrapping, and grow to their content otherwise. */
	let listClass = $derived(wrapLines ? 'w-full' : 'w-max min-w-full');
	/** Message cell: wrapped text or a single long line that scrolls sideways. */
	let messageClass = $derived(wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre');
	/** Left edge of the prefix resize handle, in pixels from the scrolled content edge. */
	let handleLeft = $derived(ROW_PADDING_PX + TIMESTAMP_COLUMN_PX + ROW_GAP_PX + prefixPx);
	/** Prefix column width as a CSS length. */
	let prefixStyle = $derived(`max-width: ${pxToRem(prefixPx)}`);

	/** Colour for a JSON token, keeping punctuation and whitespace quiet. */
	function tokenClass(type: JsonToken['type']): string {
		switch (type) {
			case 'key':
				return 'text-sky-300';
			case 'string':
				return 'text-emerald-300';
			case 'number':
				return 'text-amber-300';
			case 'boolean':
				return 'text-fuchsia-300';
			case 'null':
				return 'text-neutral-500';
			case 'punctuation':
				return 'text-neutral-600';
			default:
				return '';
		}
	}

	/** Persists the current prefix width. */
	function savePrefixWidth(): void {
		writePref(STORAGE_KEYS.prefixWidth, String(Math.round(prefixPx)));
	}

	/** Toggles wrapping and stores the preference. */
	function toggleWrap(): void {
		wrapLines = !wrapLines;
		writePref(STORAGE_KEYS.wrap, String(wrapLines));
	}

	/** Toggles JSON pretty-printing and stores the preference. */
	function toggleJson(): void {
		jsonView = !jsonView;
		writePref(STORAGE_KEYS.jsonView, String(jsonView));
	}
</script>

<section
	class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950"
>
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-800 bg-neutral-900/40 px-3 py-2"
	>
		<StatusBadge {status} />
		<span class="text-xs text-neutral-400" data-testid="visible-count">
			{formatCount(visible.length)} shown
		</span>
		<span class="text-xs text-neutral-500" data-testid="received-count">
			{formatCount(receivedCount)} received
		</span>
		{#if pendingCount > 0}
			<span class="text-xs text-amber-300" data-testid="pending-count">
				{formatCount(pendingCount)} buffered
			</span>
		{/if}
		{#if droppedCount > 0}
			<span class="text-xs text-amber-300/80" data-testid="dropped-count">
				{formatCount(droppedCount)} dropped
			</span>
		{/if}
		<span
			class="rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium {windowSummary.mode ===
			'historic'
				? 'border-amber-900 bg-amber-950/40 text-amber-300'
				: 'border-neutral-800 bg-neutral-900 text-neutral-400'}"
			title={windowSummary.title}
			data-testid="window-chip"
		>
			{windowSummary.label}
		</span>
		{#if windowSummary.clamped}
			<span class="text-[0.6875rem] text-amber-400/80" data-testid="window-clamped">
				14-day limit
			</span>
		{/if}
		{#if windowComplete}
			<span class="text-[0.6875rem] text-emerald-400/80" data-testid="window-complete">
				window complete
			</span>
		{/if}

		<div class="ml-auto flex flex-wrap items-center gap-2">
			<input
				type="search"
				aria-label="Filter log lines"
				placeholder="Filter lines"
				value={filter}
				oninput={(event) => onFilterChange?.(event.currentTarget.value)}
				class="w-40 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 hover:border-neutral-700 focus:border-sky-600"
			/>
			<button
				type="button"
				onclick={toggleWrap}
				aria-pressed={wrapLines}
				title="Wrap long lines instead of scrolling sideways"
				data-testid="wrap-toggle"
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium transition-colors hover:border-neutral-700 {wrapTone}"
			>
				Wrap
			</button>
			<button
				type="button"
				onclick={toggleJson}
				aria-pressed={jsonView}
				title="Pretty-print JSON log entries"
				data-testid="json-toggle"
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium transition-colors hover:border-neutral-700 {jsonTone}"
			>
				JSON
			</button>
			<button
				type="button"
				onclick={() => onPauseToggle?.()}
				aria-pressed={paused}
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
			>
				{paused ? 'Resume' : 'Pause'}
			</button>
			<button
				type="button"
				onclick={() => onClear?.()}
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
			>
				Clear
			</button>
			<button
				type="button"
				onclick={() => onAutoScrollToggle?.()}
				aria-pressed={autoScroll}
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium transition-colors hover:border-neutral-700 {autoScrollTone}"
			>
				Auto-scroll
			</button>
		</div>
	</div>

	{#if errorText !== null}
		<p
			role="alert"
			data-testid="stream-error"
			class="border-b border-red-900 bg-red-950/50 px-3 py-2 text-xs leading-5 text-red-300"
		>
			{errorText}
		</p>
	{/if}

	<div
		bind:this={scroller}
		class="min-h-0 min-w-0 flex-1 overflow-auto bg-neutral-950"
		data-testid="log-scroller"
	>
		{#if group === null || group === ''}
			<p class="px-3 py-6 text-sm text-neutral-500" data-testid="viewer-idle">
				Select a log group to start tailing.
			</p>
		{:else if rows.length === 0}
			<p class="px-3 py-6 text-sm text-neutral-500" data-testid="viewer-empty">
				{emptyText}
			</p>
		{:else}
			<!-- The handle lives inside the scrolled content so it stays on the column edge. -->
			<div class="relative min-h-full {listClass}" data-testid="log-canvas">
				<ol class="font-mono text-xs leading-5" data-testid="log-lines">
					{#each rows as row (row.key)}
						<li
							class="flex items-baseline gap-2 px-3 py-0.5 hover:bg-neutral-900/60 {listClass}"
							data-testid="log-line"
							data-level={row.level}
						>
							<span class="w-[7.5rem] shrink-0 text-neutral-500" title={row.timestamp}>
								{row.time}
							</span>
							<span
								class="shrink-0 truncate text-sky-400/80"
								style={prefixStyle}
								title={row.streamName ?? ''}
								data-testid="log-stream"
							>
								{row.streamName ?? ''}
							</span>
							<span class="{messageClass} {row.levelClass}" data-testid="log-message">
								{#if row.tokens !== null}
									{#each row.tokens as token, tokenIndex (`${row.key}-${tokenIndex}`)}<span
											class={tokenClass(token.type)}>{token.text}</span
										>{/each}
								{:else}
									{row.message}
								{/if}
							</span>
						</li>
					{/each}
				</ol>

				<ColumnResizer
					label="Resize prefix column"
					width={prefixPx}
					min={PREFIX_MIN_PX}
					max={PREFIX_MAX_PX}
					testId="prefix-resizer"
					onChange={(next) => (prefixPx = next)}
					onCommit={() => savePrefixWidth()}
					class="absolute inset-y-0 w-2"
					style="left: {handleLeft - 4}px"
				/>
			</div>
		{/if}
	</div>
</section>
