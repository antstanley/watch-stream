import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LogViewer from './LogViewer.svelte';
import type { LogEventDto } from '$lib/types';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => {
	cleanup();
	localStorage.clear();
});

const LINES: LogEventDto[] = [
	{
		id: 'a',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 5, 678),
		message: 'ERROR keep this line',
		streamName: 'stream-1',
	},
	{
		id: 'b',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 6, 0),
		message: 'harmless noise',
		streamName: 'stream-2',
	},
];

describe('LogViewer', () => {
	it('renders the provided lines with time, stream name and level', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				region: 'us-east-1',
				status: 'live',
				receivedCount: 2,
			},
		});

		const rows = screen.getAllByTestId('log-line');
		expect(rows).toHaveLength(2);
		expect(screen.getByText('ERROR keep this line')).toBeTruthy();
		expect(screen.getByText('stream-1')).toBeTruthy();
		expect(screen.getByText('03:04:05.678')).toBeTruthy();
		expect(rows[0].dataset.level).toBe('error');
		expect(rows[1].dataset.level).toBe('info');
		expect(screen.getByText('ERROR keep this line').className).toContain('text-red-400');
	});

	it('hides lines that do not match the filter', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app', filter: 'KEEP' } });

		expect(screen.getAllByTestId('log-line')).toHaveLength(1);
		expect(screen.queryByText('harmless noise')).toBeNull();
	});

	it('calls the toolbar handlers for pause, clear and auto-scroll', async () => {
		const onPauseToggle = vi.fn<() => void>();
		const onClear = vi.fn<() => void>();
		const onAutoScrollToggle = vi.fn<() => void>();
		render(LogViewer, {
			props: { lines: LINES, group: '/aws/app', onPauseToggle, onClear, onAutoScrollToggle },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Auto-scroll' }));

		expect(onPauseToggle).toHaveBeenCalledTimes(1);
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onAutoScrollToggle).toHaveBeenCalledTimes(1);
	});

	it('reports filter typing and shows Resume while paused', async () => {
		const onFilterChange = vi.fn<(value: string) => void>();
		render(LogViewer, {
			props: { lines: LINES, group: '/aws/app', paused: true, onFilterChange },
		});

		expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();

		await fireEvent.input(screen.getByLabelText('Filter log lines'), { target: { value: 'boom' } });

		expect(onFilterChange).toHaveBeenCalledWith('boom');
	});

	it('shows the idle prompt when no group is selected', () => {
		render(LogViewer, { props: {} });

		expect(screen.getByTestId('viewer-idle')).toBeTruthy();
		expect(screen.queryAllByTestId('log-line')).toHaveLength(0);
	});

	it('shows the waiting state for a selected group without lines', () => {
		render(LogViewer, { props: { lines: [], group: '/aws/app', status: 'live' } });

		expect(screen.getByTestId('viewer-empty').textContent).toContain(
			'Waiting for events from /aws/app',
		);
	});

	it('shows a stream error with group and region context', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				region: 'us-east-1',
				status: 'error',
				error: { message: 'No log groups found' },
			},
		});

		expect(screen.getByRole('alert').textContent).toContain(
			'No log groups found (/aws/app in us-east-1)',
		);
		// The buffered lines stay visible while an error is shown.
		expect(screen.getAllByTestId('log-line')).toHaveLength(2);
	});
});

describe('LogViewer JSON handling', () => {
	const JSON_LINE: LogEventDto = {
		id: 'j',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 5, 678),
		message: '{"level":"info","order":{"id":"ord_1","items":[1,2]}}',
		streamName: 'stream-json',
	};

	it('pretty-prints JSON messages by default', () => {
		render(LogViewer, { props: { lines: [JSON_LINE], group: '/aws/app', region: 'us-east-1' } });

		const message = screen.getByTestId('log-message');
		expect(message.textContent).toContain('{\n  "level": "info",');
		// Colouring comes from token spans, so the raw text is split across elements.
		expect(message.querySelectorAll('span').length).toBeGreaterThan(3);
		expect(message.className).toContain('whitespace-pre');
	});

	it('renders the raw line when the JSON toggle is switched off', async () => {
		render(LogViewer, { props: { lines: [JSON_LINE], group: '/aws/app' } });

		await fireEvent.click(screen.getByTestId('json-toggle'));

		expect(screen.getByTestId('log-message').textContent).toBe(JSON_LINE.message);
		expect(screen.getByTestId('json-toggle').getAttribute('aria-pressed')).toBe('false');
	});

	it('leaves non-JSON lines untouched', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		expect(screen.getByText('ERROR keep this line').textContent).toBe('ERROR keep this line');
	});
});

/** Class list of the first rendered message cell. */
function firstMessageClass(): string {
	return screen.getAllByTestId('log-message')[0].className;
}

describe('LogViewer layout controls', () => {
	it('does not wrap long lines by default and wraps them when toggled', async () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		const canvas = screen.getByTestId('log-canvas');
		expect(canvas.className).toContain('w-max');
		expect(firstMessageClass()).toContain('whitespace-pre');
		expect(firstMessageClass()).not.toContain('whitespace-pre-wrap');

		await fireEvent.click(screen.getByTestId('wrap-toggle'));

		expect(screen.getByTestId('log-canvas').className).toContain('w-full');
		expect(firstMessageClass()).toContain('whitespace-pre-wrap');
	});

	it('truncates a long Lambda stream name so the message stays visible', () => {
		const longStream =
			'2026/09/11/watch-stream-demo-backend-WhatsAppApiWebh0okFnE1B794-V02WQc7jN0VN[$LATEST]a2561676c1814e2d8bf96571caf8fb57';
		render(LogViewer, {
			props: {
				lines: [{ ...LINES[0], streamName: longStream }],
				group: '/aws/lambda/demo',
			},
		});

		const stream = screen.getByTestId('log-stream');
		expect(stream.className).toContain('truncate');
		expect(stream.getAttribute('title')).toBe(longStream);
		expect(stream.getAttribute('style')).toContain('max-width');
		expect(screen.getByTestId('log-message').textContent).toContain('ERROR keep this line');
	});

	it('exposes the prefix resizer with separator semantics', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		const handle = screen.getByTestId('prefix-resizer');
		expect(handle.getAttribute('role')).toBe('separator');
		expect(handle.getAttribute('aria-orientation')).toBe('vertical');
		expect(handle.getAttribute('aria-label')).toBe('Resize prefix column');
		expect(handle.getAttribute('tabindex')).toBe('0');
		expect(Number(handle.getAttribute('aria-valuenow'))).toBe(224);
	});

	it('resizes the prefix column with the arrow keys and with a pointer drag', async () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		const handle = screen.getByTestId('prefix-resizer');
		await fireEvent.keyDown(handle, { key: 'ArrowRight' });
		expect(Number(handle.getAttribute('aria-valuenow'))).toBe(240);

		await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		expect(Number(handle.getAttribute('aria-valuenow'))).toBe(208);

		await fireEvent(handle, new MouseEvent('pointerdown', { clientX: 300, bubbles: true }));
		await fireEvent(handle, new MouseEvent('pointermove', { clientX: 360, bubbles: true }));
		await fireEvent(handle, new MouseEvent('pointerup', { clientX: 360, bubbles: true }));
		expect(Number(handle.getAttribute('aria-valuenow'))).toBe(268);
	});

	it('persists the view preferences in localStorage', async () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		await fireEvent.click(screen.getByTestId('json-toggle'));
		await fireEvent.click(screen.getByTestId('wrap-toggle'));
		await fireEvent.keyDown(screen.getByTestId('prefix-resizer'), { key: 'ArrowRight' });

		expect(localStorage.getItem('watch-stream:json-view')).toBe('false');
		expect(localStorage.getItem('watch-stream:wrap')).toBe('true');
		expect(localStorage.getItem('watch-stream:prefix-width')).toBe('240');
	});

	it('restores the stored preferences on mount', async () => {
		localStorage.setItem('watch-stream:json-view', 'false');
		localStorage.setItem('watch-stream:wrap', 'true');
		localStorage.setItem('watch-stream:prefix-width', '320');

		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });
		await Promise.resolve();

		expect(screen.getByTestId('json-toggle').getAttribute('aria-pressed')).toBe('false');
		expect(screen.getByTestId('log-canvas').className).toContain('w-full');
		expect(Number(screen.getByTestId('prefix-resizer').getAttribute('aria-valuenow'))).toBe(320);
	});
});

describe('LogViewer window chip', () => {
	const ready = {
		region: 'us-east-1',
		logGroupName: '/aws/app',
		endpoint: null,
		startTime: Date.UTC(2024, 4, 10, 11, 0, 0),
		endTime: Date.UTC(2024, 4, 10, 12, 0, 0),
		mode: 'historic' as const,
		preset: '1h',
		clamped: false,
	};

	it('shows a live chip by default', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });
		expect(screen.getByTestId('window-chip').textContent).toContain('live');
	});

	it('shows the historic preset and bounds', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app', mode: 'historic', ready } });

		const chip = screen.getByTestId('window-chip');
		expect(chip.textContent).toContain('1 hour');
		expect(chip.textContent).toContain('→');
	});

	it('flags a clamped window and a completed scan', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				mode: 'historic',
				ready: { ...ready, clamped: true },
				endReason: 'window-complete',
			},
		});

		expect(screen.getByTestId('window-clamped').textContent).toContain('14-day');
		expect(screen.getByTestId('window-complete').textContent).toContain('window complete');
	});

	it('does not claim completion for a live tail', () => {
		render(LogViewer, {
			props: { lines: LINES, group: '/aws/app', endReason: 'client-disconnected' },
		});
		expect(screen.queryByTestId('window-complete')).toBeNull();
	});
});
