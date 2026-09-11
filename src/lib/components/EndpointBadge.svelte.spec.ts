import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import EndpointBadge from './EndpointBadge.svelte';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => cleanup());

describe('EndpointBadge', () => {
	it('shows the emulator badge and the dev-creds hint for emulator-default credentials', () => {
		render(EndpointBadge, {
			props: { endpoint: 'http://localhost:4566', credentials: 'emulator-default' },
		});

		const badge = screen.getByTestId('endpoint-badge');
		expect(badge.textContent?.trim()).toBe('floci http://localhost:4566');
		expect(badge.title).toContain('throwaway credentials');
		expect(badge.title).toContain('no ambient AWS credentials');
		expect(screen.getByTestId('credentials-hint').textContent?.trim()).toBe('dev creds');
	});

	it('keeps the plain badge and no hint for ambient credentials', () => {
		render(EndpointBadge, {
			props: { endpoint: 'http://localhost:4566', credentials: 'ambient' },
		});

		const badge = screen.getByTestId('endpoint-badge');
		expect(badge.textContent?.trim()).toBe('floci http://localhost:4566');
		expect(badge.title).toBe('Local emulator endpoint');
		expect(screen.queryByTestId('credentials-hint')).toBeNull();
	});

	it('shows no hint when the credentials mode is unknown', () => {
		render(EndpointBadge, { props: { endpoint: 'http://localhost:4566' } });

		expect(screen.getByTestId('endpoint-badge')).toBeTruthy();
		expect(screen.queryByTestId('credentials-hint')).toBeNull();
	});

	it('renders nothing without an endpoint, even with emulator-default credentials', () => {
		render(EndpointBadge, { props: { endpoint: null, credentials: 'emulator-default' } });

		expect(screen.queryByTestId('endpoint-badge')).toBeNull();
		expect(screen.queryByTestId('credentials-hint')).toBeNull();
	});

	it('labels a non-floci override as a generic local emulator', () => {
		render(EndpointBadge, { props: { endpoint: 'http://127.0.0.1:9999' } });

		expect(screen.getByTestId('endpoint-badge').textContent?.trim()).toBe(
			'local emulator http://127.0.0.1:9999',
		);
	});
});
