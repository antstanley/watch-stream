import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeSelect from './ThemeSelect.svelte';
import { THEMES, THEME_STORAGE_KEY } from '$lib/themes';

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	delete document.documentElement.dataset.theme;
});

describe('ThemeSelect', () => {
	it('offers four dark and four light themes', () => {
		render(ThemeSelect);
		expect(screen.getAllByRole('option')).toHaveLength(8);
		for (const mode of ['dark', 'light'])
			expect(THEMES.filter((theme) => theme.mode === mode)).toHaveLength(4);
	});
	it('applies the choice immediately and restores it on the next visit', async () => {
		const view = render(ThemeSelect);
		await fireEvent.change(screen.getByLabelText('Colour theme'), { target: { value: 'mint' } });
		expect(document.documentElement.dataset.theme).toBe('mint');
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('mint');
		view.unmount();
		render(ThemeSelect);
		expect((screen.getByLabelText('Colour theme') as HTMLSelectElement).value).toBe('mint');
	});
	it('falls back when a saved theme no longer exists', () => {
		localStorage.setItem(THEME_STORAGE_KEY, 'obsolete');
		render(ThemeSelect);
		expect(document.documentElement.dataset.theme).toBe('midnight');
	});
	it('still switches when storage is blocked', async () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		render(ThemeSelect);
		await fireEvent.change(screen.getByLabelText('Colour theme'), { target: { value: 'sand' } });
		expect(document.documentElement.dataset.theme).toBe('sand');
	});
});
