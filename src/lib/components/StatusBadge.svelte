<script lang="ts">
	import type { StreamState } from '$lib/types';

	type Props = {
		/** Connection status reported by the log stream. */
		status: StreamState;
	};

	let { status }: Props = $props();

	/** Pill text per status. */
	const LABELS: Record<StreamState, string> = {
		idle: 'idle',
		connecting: 'connecting',
		live: 'live',
		reconnecting: 'reconnecting',
		error: 'error',
		ended: 'ended',
	};

	/** Pill colours per status. */
	const TONES: Record<StreamState, string> = {
		idle: 'border-neutral-700 bg-neutral-800/60 text-neutral-400',
		connecting: 'border-sky-900 bg-sky-950/70 text-sky-300',
		live: 'border-emerald-900 bg-emerald-950/70 text-emerald-300',
		reconnecting: 'border-amber-900 bg-amber-950/70 text-amber-300',
		error: 'border-red-900 bg-red-950/70 text-red-300',
		ended: 'border-neutral-700 bg-neutral-800/60 text-neutral-400',
	};

	/** Dot colours per status. */
	const DOTS: Record<StreamState, string> = {
		idle: 'bg-neutral-500',
		connecting: 'bg-sky-400 animate-pulse',
		live: 'bg-emerald-400',
		reconnecting: 'bg-amber-400 animate-pulse',
		error: 'bg-red-400',
		ended: 'bg-neutral-500',
	};

	let tone = $derived(TONES[status]);
	let dot = $derived(DOTS[status]);
	let text = $derived(LABELS[status]);
</script>

<span
	data-testid="status-badge"
	data-status={status}
	class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium {tone}"
>
	<span class="size-1.5 rounded-full {dot}" aria-hidden="true"></span>
	{text}
</span>
