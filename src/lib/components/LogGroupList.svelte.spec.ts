import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LogGroupList from './LogGroupList.svelte';
import type { LogGroupSummary } from '$lib/types';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => cleanup());

const GROUPS: LogGroupSummary[] = [
	{
		name: '/aws/lambda/checkout',
		arn: 'arn:aws:logs:us-east-1:1:log-group:/aws/lambda/checkout',
		storedBytes: 2048,
	},
	{ name: '/aws/lambda/orders', storedBytes: 0 },
];

describe('LogGroupList', () => {
	it('shows a loading skeleton while the request is in flight', () => {
		render(LogGroupList, { props: { loading: true, region: 'us-east-1' } });

		expect(screen.getByTestId('group-loading')).toBeTruthy();
		expect(screen.getByText(/loading log groups/i)).toBeTruthy();
		expect(screen.queryAllByTestId('group-row')).toHaveLength(0);
	});

	it('shows the empty state with region and seed context', () => {
		render(LogGroupList, { props: { groups: [], region: 'eu-west-1' } });

		const empty = screen.getByTestId('group-empty');
		expect(empty.textContent).toContain('eu-west-1');
		expect(empty.textContent).toContain('pnpm seed');
	});

	it('shows the API error message', () => {
		render(LogGroupList, {
			props: {
				region: 'us-east-1',
				error: 'Could not list log groups in us-east-1: Access denied.',
			},
		});

		expect(screen.getByRole('alert').textContent).toContain('Access denied');
		expect(screen.queryAllByTestId('group-row')).toHaveLength(0);
	});

	it('renders the groups with their stored size', () => {
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1' } });

		expect(screen.getAllByTestId('group-row')).toHaveLength(2);
		expect(screen.getByText('2 KiB')).toBeTruthy();
		expect(screen.getByText('0 B')).toBeTruthy();
	});

	it('filters by search text, case-insensitively', async () => {
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1' } });

		await fireEvent.input(screen.getByLabelText('Search log groups'), {
			target: { value: 'CHECKOUT' },
		});

		expect(screen.getAllByTestId('group-row')).toHaveLength(1);
		expect(screen.queryByText('/aws/lambda/orders')).toBeNull();
	});

	it('shows a message when nothing matches the search', async () => {
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1' } });

		await fireEvent.input(screen.getByLabelText('Search log groups'), {
			target: { value: 'nothing' },
		});

		expect(screen.getByTestId('group-no-match').textContent).toContain('nothing');
	});

	it('calls the select handler with the group name on click', async () => {
		const onSelect = vi.fn<(name: string) => void>();
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1', onSelect } });

		await fireEvent.click(screen.getByText('/aws/lambda/orders'));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith('/aws/lambda/orders');
	});

	it('calls the refresh handler on click', async () => {
		const onRefresh = vi.fn<() => void>();
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1', onRefresh } });

		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it('renders at most maxRows rows and says so', () => {
		const many: LogGroupSummary[] = Array.from({ length: 8 }, (_value, index) => ({
			name: `/aws/lambda/app-${index}`,
		}));
		render(LogGroupList, { props: { groups: many, region: 'us-east-1', maxRows: 3 } });

		expect(screen.getAllByTestId('group-row')).toHaveLength(3);
		expect(screen.getByTestId('group-truncated').textContent).toContain('Showing first 3 of 8');
	});
});
