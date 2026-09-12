/**
 * Client test setup.
 *
 * layerchart measures its container and reads media queries while it loads, and
 * jsdom implements neither `matchMedia` nor `ResizeObserver` (and reports every
 * element as zero-sized). The chart component is a real part of the page, so
 * these stubs make it importable and renderable in tests instead of mocking the
 * component away.
 */
import { vi } from 'vitest';

/** The size jsdom refuses to compute, in the shape the DOM expects. */
function measuredRect(): DOMRect {
	return {
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 640,
		bottom: 240,
		width: 640,
		height: 240,
		toJSON: () => ({}),
	} as DOMRect;
}

if (typeof window !== 'undefined') {
	if (typeof window.matchMedia !== 'function') {
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		})) as unknown as typeof window.matchMedia;
	}

	if (typeof globalThis.ResizeObserver !== 'function') {
		class ResizeObserverStub {
			observe(): void {
				// Nothing to measure in jsdom.
			}
			unobserve(): void {
				// Nothing to unmeasure either.
			}
			disconnect(): void {
				// No observers were registered.
			}
		}
		globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
	}

	// layerchart lays out from the container's measured size; jsdom reports 0.
	Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => 640,
	});
	Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get: () => 240,
	});
	window.HTMLElement.prototype.getBoundingClientRect = measuredRect;
}

// Silence the animation frames svelte's motion helpers may schedule.
if (typeof globalThis.requestAnimationFrame !== 'function') {
	globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
		setTimeout(() => callback(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = ((handle: number) =>
		clearTimeout(
			handle as unknown as ReturnType<typeof setTimeout>,
		)) as typeof cancelAnimationFrame;
}

vi.stubGlobal('matchMedia', (query: string) => ({
	matches: false,
	media: query,
	onchange: null,
	addListener: () => undefined,
	removeListener: () => undefined,
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
	dispatchEvent: () => false,
}));
