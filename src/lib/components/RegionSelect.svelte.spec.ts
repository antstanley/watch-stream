import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REGIONS } from '$lib/groups-client';
import RegionSelect from './RegionSelect.svelte';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => cleanup());

/** Reads the option values of the rendered select. */
function optionValues(): string[] {
	const select = screen.getByRole('combobox') as HTMLSelectElement;
	return [...select.options].map((option) => option.value);
}

describe('RegionSelect', () => {
	it('renders the default region options and the current value', () => {
		render(RegionSelect, { props: { value: 'us-east-1' } });

		expect(optionValues()).toEqual([...DEFAULT_REGIONS]);
		expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('us-east-1');
	});

	it('emits the newly selected region', async () => {
		const onchange = vi.fn<(region: string) => void>();
		render(RegionSelect, { props: { value: 'us-east-1', onchange } });

		await fireEvent.change(screen.getByRole('combobox'), { target: { value: 'eu-west-1' } });

		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith('eu-west-1');
	});

	it('keeps a region that the server did not list', () => {
		render(RegionSelect, { props: { regions: ['us-east-1'], value: 'af-south-1' } });

		expect(optionValues()).toEqual(['af-south-1', 'us-east-1']);
		expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('af-south-1');
	});

	it('honours a custom label', () => {
		render(RegionSelect, { props: { label: 'AWS region' } });
		expect(screen.getByLabelText('AWS region')).toBeTruthy();
	});
});
