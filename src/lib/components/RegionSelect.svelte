<script lang="ts">
	import { DEFAULT_REGIONS } from '$lib/groups-client';

	type Props = {
		/** Regions offered by the picker; defaults to {@link DEFAULT_REGIONS}. */
		regions?: readonly string[];
		/** Currently selected region. */
		value?: string;
		disabled?: boolean;
		label?: string;
		id?: string;
		/** Called with the newly selected region. */
		onchange?: (region: string) => void;
	};

	let {
		regions = DEFAULT_REGIONS,
		value = '',
		disabled = false,
		label = 'Region',
		id = 'region-select',
		onchange,
	}: Props = $props();

	/** Offered regions, plus the current value when the server does not list it. */
	let options = $derived(
		value !== '' && !regions.includes(value) ? [value, ...regions] : [...regions],
	);
</script>

<div class="flex flex-col gap-1.5">
	<label for={id} class="text-[0.6875rem] font-semibold uppercase tracking-wider text-neutral-500">
		{label}
	</label>
	<select
		{id}
		{disabled}
		{value}
		onchange={(event) => onchange?.(event.currentTarget.value)}
		class="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-100 outline-none transition-colors hover:border-neutral-700 focus:border-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
	>
		{#each options as option (option)}
			<option value={option}>{option}</option>
		{/each}
	</select>
</div>
