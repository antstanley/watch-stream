import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RangeControls from './RangeControls.svelte';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => cleanup());

type Apply = (payload: {
	mode: 'live' | 'historic';
	range: string;
	from: number | null;
	to: number | null;
}) => void;

/** Renders the controls with an optional prop override and returns the apply spy. */
function setup(overrides: Record<string, unknown> = {}) {
	const onApply = vi.fn<Apply>();
	render(RangeControls, { props: { onApply, ...overrides } });
	return onApply;
}

describe('RangeControls', () => {
	it('starts in live mode with the historic toggle available', () => {
		setup();

		expect(screen.getByTestId('mode-live').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('mode-historic').getAttribute('aria-pressed')).toBe('false');
		// Presets only matter once a window is being chosen.
		expect(screen.queryByTestId('preset-24h')).toBeNull();
	});

	it('switches to historic mode with the default preset', async () => {
		const onApply = setup();

		await fireEvent.click(screen.getByTestId('mode-historic'));

		expect(onApply).toHaveBeenCalledWith({ mode: 'historic', range: '15m', from: null, to: null });
	});

	it('renders every preset and applies the selected one', async () => {
		const onApply = setup({ mode: 'historic', range: '15m' });

		for (const preset of [
			'preset-15m',
			'preset-1h',
			'preset-3h',
			'preset-12h',
			'preset-24h',
			'preset-5d',
		]) {
			expect(screen.getByTestId(preset)).toBeTruthy();
		}
		expect(screen.getByTestId('preset-15m').getAttribute('aria-pressed')).toBe('true');

		await fireEvent.click(screen.getByTestId('preset-5d'));

		expect(onApply).toHaveBeenCalledWith({ mode: 'historic', range: '5d', from: null, to: null });
	});

	it('opens the custom editor with the active window and applies local times as epoch ms', async () => {
		const onApply = setup({
			mode: 'historic',
			range: '',
			from: 1_700_000_000_000,
			to: 1_700_003_600_000,
		});

		const editor = screen.getByTestId('custom-window');
		expect(editor).toBeTruthy();

		await fireEvent.input(screen.getByTestId('custom-from'), {
			target: { value: '2024-05-10T10:00' },
		});
		await fireEvent.input(screen.getByTestId('custom-to'), {
			target: { value: '2024-05-10T12:30' },
		});
		await fireEvent.click(screen.getByTestId('custom-apply'));

		expect(onApply).toHaveBeenCalledTimes(1);
		const payload = onApply.mock.calls[0][0];
		expect(payload.mode).toBe('historic');
		expect(payload.range).toBe('');
		expect(payload.from).toBe(Date.parse('2024-05-10T10:00'));
		expect(payload.to).toBe(Date.parse('2024-05-10T12:30'));
	});

	it('rejects an inverted or oversized custom window', async () => {
		const onApply = setup({ mode: 'historic', range: '' });

		await fireEvent.click(screen.getByTestId('preset-custom'));
		await fireEvent.input(screen.getByTestId('custom-from'), {
			target: { value: '2024-05-10T12:00' },
		});
		await fireEvent.input(screen.getByTestId('custom-to'), {
			target: { value: '2024-05-10T11:00' },
		});
		await fireEvent.click(screen.getByTestId('custom-apply'));

		expect(onApply).not.toHaveBeenCalled();
		expect(screen.getByTestId('custom-error').textContent).toContain('end must be after the start');

		// Ten months is far beyond the 14 days CloudWatch Logs keeps.
		await fireEvent.input(screen.getByTestId('custom-from'), {
			target: { value: '2024-01-01T00:00' },
		});
		await fireEvent.input(screen.getByTestId('custom-to'), {
			target: { value: '2024-05-10T11:00' },
		});
		await fireEvent.click(screen.getByTestId('custom-apply'));

		expect(onApply).not.toHaveBeenCalled();
		expect(screen.getByTestId('custom-error').textContent).toContain('14 days');
	});

	it('shows a loading hint and disables presets while a window is fetching', () => {
		setup({ mode: 'historic', range: '24h', loading: true, disabled: true });

		expect(screen.getByTestId('range-loading').textContent).toContain('loading');
		expect(screen.getByTestId('preset-24h').hasAttribute('disabled')).toBe(true);
	});

	it('describes the active preset when idle', () => {
		setup({ mode: 'historic', range: '12h' });
		expect(screen.getByText('last 12 hours')).toBeTruthy();
	});
});
