import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import StatusBadge from './StatusBadge.svelte';
import type { StreamState } from '$lib/types';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => cleanup());

const STATUSES: StreamState[] = ['idle', 'connecting', 'live', 'reconnecting', 'error', 'ended'];

describe('StatusBadge', () => {
	it('renders the label and data attribute for every status', () => {
		for (const status of STATUSES) {
			const { unmount } = render(StatusBadge, { props: { status } });
			const badge = screen.getByTestId('status-badge');
			expect(badge.textContent?.trim()).toBe(status);
			expect(badge.dataset.status).toBe(status);
			unmount();
		}
	});

	it('uses different tones for live and error', () => {
		const live = render(StatusBadge, { props: { status: 'live' } });
		const liveClasses = screen.getByTestId('status-badge').className;
		live.unmount();

		render(StatusBadge, { props: { status: 'error' } });
		const errorClasses = screen.getByTestId('status-badge').className;

		expect(liveClasses).toContain('emerald');
		expect(errorClasses).toContain('red');
	});
});
