import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ColumnResizer from './ColumnResizer.svelte';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => cleanup());

/** Renders a resizer and returns the element plus its change/commit spies. */
function setup(overrides: Record<string, unknown> = {}) {
	const onChange = vi.fn<(width: number) => void>();
	const onCommit = vi.fn<(width: number) => void>();
	const props = {
		label: 'Resize group list',
		width: 224,
		min: 64,
		max: 640,
		testId: 'resizer',
		onChange,
		onCommit,
		...overrides,
	};
	render(ColumnResizer, { props });
	return { element: screen.getByTestId('resizer'), onChange, onCommit };
}

describe('ColumnResizer', () => {
	it('exposes separator semantics for assistive technology', () => {
		const { element } = setup();

		expect(element.getAttribute('role')).toBe('separator');
		expect(element.getAttribute('aria-orientation')).toBe('vertical');
		expect(element.getAttribute('aria-label')).toBe('Resize group list');
		expect(element.getAttribute('aria-valuemin')).toBe('64');
		expect(element.getAttribute('aria-valuemax')).toBe('640');
		expect(element.getAttribute('aria-valuenow')).toBe('224');
		expect(element.getAttribute('tabindex')).toBe('0');
	});

	it('reports the width implied by a pointer drag and commits on release', async () => {
		const { element, onChange, onCommit } = setup();

		await fireEvent(element, new MouseEvent('pointerdown', { clientX: 100, bubbles: true }));
		await fireEvent(element, new MouseEvent('pointermove', { clientX: 140, bubbles: true }));

		expect(onChange).toHaveBeenCalledWith(264);

		await fireEvent(element, new MouseEvent('pointerup', { clientX: 140, bubbles: true }));
		expect(onCommit).toHaveBeenCalledWith(224);
	});

	it('clamps a drag at both bounds', async () => {
		const { element, onChange } = setup();

		await fireEvent(element, new MouseEvent('pointerdown', { clientX: 200, bubbles: true }));
		await fireEvent(element, new MouseEvent('pointermove', { clientX: -1000, bubbles: true }));
		expect(onChange).toHaveBeenLastCalledWith(64);

		await fireEvent(element, new MouseEvent('pointermove', { clientX: 5000, bubbles: true }));
		expect(onChange).toHaveBeenLastCalledWith(640);
	});

	it('ignores pointer moves before a drag starts', async () => {
		const { element, onChange, onCommit } = setup();

		await fireEvent(element, new MouseEvent('pointermove', { clientX: 400, bubbles: true }));
		await fireEvent(element, new MouseEvent('pointerup', { clientX: 400, bubbles: true }));

		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
	});

	it('nudges the width with the arrow keys and ignores other keys', async () => {
		const { element, onChange, onCommit } = setup();

		await fireEvent.keyDown(element, { key: 'ArrowRight' });
		expect(onChange).toHaveBeenLastCalledWith(240);
		expect(onCommit).toHaveBeenLastCalledWith(240);

		// The prop stays at 224 in this harness, so the step is computed from 224 either way.
		await fireEvent.keyDown(element, { key: 'ArrowLeft' });
		expect(onChange).toHaveBeenLastCalledWith(208);

		onChange.mockClear();
		await fireEvent.keyDown(element, { key: 'Enter' });
		expect(onChange).not.toHaveBeenCalled();
	});

	it('does not step past the bounds with the keyboard', async () => {
		const { element, onChange } = setup({ width: 70 });

		await fireEvent.keyDown(element, { key: 'ArrowLeft' });
		expect(onChange).toHaveBeenLastCalledWith(64);
	});

	it('applies extra positioning classes and inline style', () => {
		const { element } = setup({ class: 'absolute inset-y-0 w-2', style: 'left: 120px' });

		expect(element.className).toContain('absolute');
		expect(element.getAttribute('style')).toContain('left: 120px');
	});
});
