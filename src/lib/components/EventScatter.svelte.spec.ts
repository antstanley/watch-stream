import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventScatter from './EventScatter.svelte';
import type { SeriesPoint } from '$lib/types';

// layerchart needs browser APIs jsdom lacks; src/lib/test-setup-client.ts stubs them.

afterEach(() => cleanup());

const BASE = Date.UTC(2024, 4, 17, 12, 0, 0);
const MINUTE = 60_000;

/** Two levels over eight buckets, which is what a chart of this view looks like. */
function points(): SeriesPoint[] {
	const rows: SeriesPoint[] = [];
	for (let index = 0; index < 8; index += 1) {
		rows.push({
			t: BASE + index * MINUTE,
			group: '/aws/lambda/api',
			level: 'error',
			events: index % 3,
		});
		rows.push({
			t: BASE + index * MINUTE,
			group: '/aws/lambda/api',
			level: 'info',
			events: (index % 4) + 1,
		});
	}
	return rows;
}

/** One pointer event of a brush gesture. */
function pointerEvent(type: string, x: number): Event {
	const dispatched = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(dispatched, {
		clientX: x,
		clientY: 120,
		pointerId: 1,
		pointerType: 'mouse',
		button: 0,
		buttons: 1,
	});
	return dispatched;
}

/** Dispatches a pointer drag across the chart, the way a user brushes a range. */
function drag(fromX: number, toX: number, target: Element): void {
	target.dispatchEvent(pointerEvent('pointerdown', fromX));
	window.dispatchEvent(pointerEvent('pointermove', toX));
	window.dispatchEvent(pointerEvent('pointerup', toX));
}

describe('EventScatter', () => {
	it('draws one marker per point, coloured per level', async () => {
		const { container } = render(EventScatter, {
			props: { points: points(), from: BASE, to: BASE + 8 * MINUTE },
		});
		await waitFor(() => {
			expect(container.querySelector('.lc-root-container')).not.toBeNull();
		});
		const markers = container.querySelectorAll('.lc-circle, .lc-point, circle');
		// Sixteen points, drawn as one marker each.
		expect(markers.length).toBeGreaterThanOrEqual(16);
		expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
	});

	it('previews the range while dragging, without applying it', async () => {
		const onBrush = vi.fn<(range: { from: number; to: number } | null) => void>();
		const onBrushPreview = vi.fn<(range: { from: number; to: number } | null) => void>();
		const { container } = render(EventScatter, {
			props: {
				points: points(),
				from: BASE,
				to: BASE + 8 * MINUTE,
				onBrush,
				onBrushPreview,
			},
		});

		const brush = await waitFor(() => {
			const element = container.querySelector('.lc-brush-context');
			expect(element).not.toBeNull();
			return element as Element;
		});

		// Drag without releasing: the preview follows, the applied range does not.
		brush.dispatchEvent(pointerEvent('pointerdown', 120));
		window.dispatchEvent(pointerEvent('pointermove', 300));
		await waitFor(() => expect(onBrushPreview).toHaveBeenCalled());
		expect(onBrush).not.toHaveBeenCalled();

		window.dispatchEvent(pointerEvent('pointerup', 420));
		await waitFor(() => expect(onBrush).toHaveBeenCalledTimes(1));
		// The preview is cleared once the range has been handed over.
		expect(onBrushPreview).toHaveBeenLastCalledWith(null);
	});

	it('reports brushing and clearing through onBrush', async () => {
		const onBrush = vi.fn<(range: { from: number; to: number } | null) => void>();
		const { container } = render(EventScatter, {
			props: { points: points(), from: BASE, to: BASE + 8 * MINUTE, onBrush },
		});

		const brush = await waitFor(() => {
			const element = container.querySelector('.lc-brush-context');
			expect(element).not.toBeNull();
			return element as Element;
		});

		drag(120, 420, brush);
		await waitFor(() => expect(onBrush).toHaveBeenCalled());
		// One call per gesture: the log view is re-scoped on release, not on every
		// pointer move, so a drag does not restart the stream repeatedly.
		expect(onBrush).toHaveBeenCalledTimes(1);

		const range = onBrush.mock.calls.at(-1)?.[0] ?? null;
		expect(range).not.toBeNull();
		// The range is inside the window the chart was given, in epoch milliseconds.
		expect(range?.from).toBeGreaterThanOrEqual(BASE);
		expect(range?.to).toBeLessThanOrEqual(BASE + 8 * MINUTE);
		expect(range?.to).toBeGreaterThan(range?.from ?? 0);
	});
});

it('selects a point with mouse and keyboard without triggering the brush', async () => {
	const onSelect = vi.fn<(point: SeriesPoint) => void>();
	const onBrush = vi.fn<(range: { from: number; to: number } | null) => void>();
	const point = points()[0];
	const { container } = render(EventScatter, {
		props: { points: [point], from: BASE, to: BASE + 8 * MINUTE, onSelect, onBrush },
	});
	const marker = await waitFor(() => {
		const el = container.querySelector('[data-testid="scatter-point"]');
		expect(el).not.toBeNull();
		return el!;
	});
	marker.dispatchEvent(pointerEvent('pointerdown', 120));
	window.dispatchEvent(pointerEvent('pointerup', 120));
	await fireEvent.click(marker);
	expect(onSelect).toHaveBeenLastCalledWith(point);
	expect(onBrush).not.toHaveBeenCalled();
	await fireEvent.keyDown(marker, { key: 'Enter' });
	await fireEvent.keyDown(marker, { key: ' ' });
	expect(onSelect).toHaveBeenCalledTimes(3);
});
