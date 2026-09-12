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

const ARCHIVED: LogGroupSummary[] = [
	{
		name: '/aws/lambda/checkout',
		archivedEvents: 1234,
		archivedOldest: Date.UTC(2024, 0, 2, 3, 4, 5),
		archivedNewest: Date.UTC(2024, 0, 2, 4, 5, 6),
	},
	{ name: '/aws/lambda/orders' },
];

describe('LogGroupList archive view', () => {
	it('shows how much each group holds locally', () => {
		render(LogGroupList, { props: { groups: ARCHIVED, region: 'us-east-1', source: 'archive' } });

		// Only the group with archived events gets a badge.
		const badges = screen.getAllByTestId('group-archived-count');
		expect(badges).toHaveLength(1);
		expect(badges[0].textContent?.trim()).toBe('1,234 archived');
		expect(badges[0].getAttribute('title')).toBe(
			'2024-01-02T03:04:05.000Z \u2192 2024-01-02T04:05:06.000Z',
		);
		// The span needs room, so it lives next to the badge and is hidden when narrow.
		expect(screen.getByTestId('group-archived-span').textContent?.trim()).toBe(
			'2024-01-02T03:04:05.000Z \u2192 2024-01-02T04:05:06.000Z',
		);
		expect(screen.getByTestId('group-archived-span').className).toContain('hidden');
		expect(screen.getByTestId('group-source-badge').textContent?.trim()).toBe('local');
		expect(screen.getByText('Archived groups')).toBeTruthy();
	});

	it('keeps the CloudWatch list free of archive badges', () => {
		render(LogGroupList, { props: { groups: ARCHIVED, region: 'us-east-1' } });

		expect(screen.queryAllByTestId('group-archived-count')).toHaveLength(0);
		expect(screen.queryByTestId('group-source-badge')).toBeNull();
		expect(screen.queryByTestId('group-archived-span')).toBeNull();
		expect(screen.getByText('Log groups')).toBeTruthy();
	});

	it('shows a hint instead of an error when the archive is empty', () => {
		render(LogGroupList, { props: { groups: [], region: 'eu-west-1', source: 'archive' } });

		const empty = screen.getByTestId('group-empty');
		expect(empty.textContent).toContain('Nothing archived for eu-west-1 yet');
		expect(empty.textContent).toContain('stream a group from CloudWatch once');
		expect(screen.queryByTestId('group-error')).toBeNull();
		expect(empty.className).not.toContain('red');
	});
});
