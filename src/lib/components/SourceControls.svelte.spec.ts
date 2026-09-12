import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SourceControls from './SourceControls.svelte';
import type { StreamSource } from '$lib/types';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => cleanup());

const PATH = '/Users/dev/Library/Application Support/watch-tail/archive.duckdb';

type Change = (source: StreamSource) => void;

/** Renders the toggle with prop overrides and returns the change spy. */
function setup(overrides: Record<string, unknown> = {}) {
	const onChange = vi.fn<Change>();
	render(SourceControls, { props: { archiveAvailable: true, onChange, ...overrides } });
	return onChange;
}

describe('SourceControls', () => {
	it('renders nothing while the archive is unavailable', () => {
		render(SourceControls, { props: { archiveAvailable: false } });

		expect(screen.queryByTestId('source-cloudwatch')).toBeNull();
		expect(screen.queryByTestId('source-archive')).toBeNull();
		expect(screen.queryByText('Local archive')).toBeNull();
		expect(screen.queryByRole('group', { name: 'Log source' })).toBeNull();
		expect(screen.queryByTestId('archive-note')).toBeNull();
	});

	it('renders nothing when the archive status was never fetched', () => {
		render(SourceControls, { props: {} });

		expect(screen.queryByRole('group', { name: 'Log source' })).toBeNull();
	});

	it('offers both sources once the archive is available, starting on CloudWatch', () => {
		setup();

		expect(screen.getByTestId('source-cloudwatch').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('source-cloudwatch').textContent?.trim()).toBe('CloudWatch');
		expect(screen.getByTestId('source-archive').getAttribute('aria-pressed')).toBe('false');
		expect(screen.getByTestId('source-archive').textContent?.trim()).toBe('Local archive');
		// The archive disclaimer only matters while the archive is the active source.
		expect(screen.queryByTestId('archive-note')).toBeNull();
	});

	it('reports the archive source when Local archive is clicked', async () => {
		const onChange = setup({ archivePath: PATH });

		await fireEvent.click(screen.getByTestId('source-archive'));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith('archive');
	});

	it('names the database file behind the archive in the tooltip', () => {
		setup({ archivePath: PATH });

		const archive = screen.getByTestId('source-archive');
		expect(archive.getAttribute('title')).toContain('Locally archived events');
		expect(archive.getAttribute('title')).toContain(PATH);
	});

	it('says plainly that the archive holds locally archived events', () => {
		setup({ source: 'archive', archivePath: PATH });

		const note = screen.getByTestId('archive-note');
		expect(note.textContent).toContain('Locally archived events');
		expect(note.textContent).toContain('no CloudWatch credentials');
		expect(screen.getByTestId('source-archive').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('source-cloudwatch').getAttribute('aria-pressed')).toBe('false');
	});

	it('switches back to CloudWatch from archive mode', async () => {
		const onChange = setup({ source: 'archive' });

		await fireEvent.click(screen.getByTestId('source-cloudwatch'));

		expect(onChange).toHaveBeenCalledWith('cloudwatch');
	});

	it('does nothing when the active source is clicked again', async () => {
		const onChange = setup({ source: 'archive' });

		await fireEvent.click(screen.getByTestId('source-archive'));

		expect(onChange).not.toHaveBeenCalled();
	});

	it('works without a change handler', async () => {
		render(SourceControls, { props: { archiveAvailable: true, source: 'cloudwatch' } });

		await fireEvent.click(screen.getByTestId('source-archive'));

		expect(screen.getByTestId('source-archive')).toBeTruthy();
	});
});
