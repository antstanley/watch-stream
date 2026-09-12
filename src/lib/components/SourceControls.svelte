<script lang="ts">
	import { ARCHIVE_NOTE, describeArchive } from '$lib/groups-client';
	import type { StreamSource } from '$lib/types';

	type Props = {
		/** Active source, owned by the page. */
		source?: StreamSource;
		/**
		 * True only when `GET /api/archive` reported `available: true`.
		 * The toggle is hidden otherwise, so the app keeps its CloudWatch-only look.
		 */
		archiveAvailable?: boolean;
		/** Database file behind the archive, shown in the tooltip. */
		archivePath?: string | null;
		/** Called with the newly chosen source. */
		onChange?: (source: StreamSource) => void;
	};

	let {
		source = 'cloudwatch',
		archiveAvailable = false,
		archivePath = null,
		onChange,
	}: Props = $props();

	/** Tooltip of the archive button: what it reads and which file backs it. */
	let archiveTitle = $derived(describeArchive(archivePath));

	/** Switches source; clicking the active one changes nothing. */
	function selectSource(next: StreamSource): void {
		if (next === source) return;
		onChange?.(next);
	}
	/** Shared classes for the two source buttons. */
	const chip =
		'rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
</script>

{#if archiveAvailable}
	<div class="flex flex-col gap-1.5">
		<div
			class="flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-0.5"
			role="group"
			aria-label="Log source"
		>
			<button
				type="button"
				onclick={() => selectSource('cloudwatch')}
				aria-pressed={source === 'cloudwatch'}
				title="Stream from CloudWatch Logs with your AWS credentials"
				data-testid="source-cloudwatch"
				class="{chip} {source === 'cloudwatch'
					? 'border-sky-700 bg-sky-950/60 text-sky-300'
					: 'border-transparent text-neutral-400 hover:text-neutral-200'}"
			>
				CloudWatch
			</button>
			<button
				type="button"
				onclick={() => selectSource('archive')}
				aria-pressed={source === 'archive'}
				title={archiveTitle}
				data-testid="source-archive"
				class="{chip} {source === 'archive'
					? 'border-teal-700 bg-teal-950/60 text-teal-300'
					: 'border-transparent text-neutral-400 hover:text-neutral-200'}"
			>
				Local archive
			</button>
		</div>
		{#if source === 'archive'}
			<p
				class="text-[0.6875rem] leading-4 text-teal-300/80"
				title={archiveTitle}
				data-testid="archive-note"
			>
				{ARCHIVE_NOTE}
			</p>
		{/if}
	</div>
{/if}
