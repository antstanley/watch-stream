<script lang="ts">
	import { describeEndpoint } from '$lib/format';
	import type { CredentialsMode } from '$lib/groups-client';

	type Props = {
		/** Resolved CloudWatch Logs endpoint, or `null` when talking to real AWS. */
		endpoint?: string | null;
		/** Credential mode from `GET /api/health`, or `null` when it is unknown. */
		credentials?: CredentialsMode | null;
	};

	let { endpoint = null, credentials = null }: Props = $props();

	/** Badge text, for example `floci http://localhost:4566`; `null` hides the badge. */
	let label = $derived(describeEndpoint(endpoint));
	/** True when the server fell back to the emulator's throwaway credentials. */
	let emulatorDefault = $derived(credentials === 'emulator-default');
	let hint = $derived(
		emulatorDefault
			? "Local emulator endpoint - using floci's throwaway credentials (no ambient AWS credentials found)"
			: 'Local emulator endpoint',
	);
</script>

{#if label !== null}
	<span class="inline-flex items-center gap-1.5" title={hint}>
		<span
			data-testid="endpoint-badge"
			title={hint}
			class="rounded-full border border-violet-900 bg-violet-950/60 px-2.5 py-1 text-xs font-medium text-violet-300"
		>
			{label}
		</span>
		{#if emulatorDefault}
			<span data-testid="credentials-hint" class="text-[0.6875rem] text-neutral-500">
				dev creds
			</span>
		{/if}
	</span>
{/if}
