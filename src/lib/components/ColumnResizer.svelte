<script lang="ts">
	import { widthFromKey, widthFromPointer } from '$lib/resize';

	type Props = {
		/** Accessible name, for example "Resize group list". */
		label: string;
		/** Current width in CSS pixels. */
		width: number;
		/** Lower bound in CSS pixels. */
		min: number;
		/** Upper bound in CSS pixels. */
		max: number;
		/** `data-testid` value. */
		testId: string;
		/** Called on every pointer move and arrow key with the clamped width. */
		onChange: (width: number) => void;
		/** Called when a drag ends or an arrow key is handled, for persistence. */
		onCommit?: (width: number) => void;
		/** Extra classes, used for positioning. */
		class?: string;
		/** Extra inline style, for example `left: 120px`. */
		style?: string;
	};

	let {
		label,
		width,
		min,
		max,
		testId,
		onChange,
		onCommit,
		class: className = '',
		style = '',
	}: Props = $props();

	/** Active drag, or `null`. */
	let drag: { x: number; width: number } | null = null;

	/** Starts a drag and captures the pointer so moves keep arriving. */
	function startDrag(event: PointerEvent): void {
		drag = { x: event.clientX, width };
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		event.preventDefault();
	}

	/** Reports the width implied by the pointer position. */
	function moveDrag(event: PointerEvent): void {
		if (drag === null) return;
		onChange(
			widthFromPointer({
				startWidth: drag.width,
				startX: drag.x,
				currentX: event.clientX,
				min,
				max,
			}),
		);
		event.preventDefault();
	}

	/** Ends a drag, releasing the pointer and committing the final width. */
	function endDrag(event: PointerEvent): void {
		if (drag === null) return;
		drag = null;
		(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
		onCommit?.(width);
	}

	/** Arrow keys nudge the column; other keys are left to the page. */
	function handleKeydown(event: KeyboardEvent): void {
		const next = widthFromKey({ width, key: event.key, min, max });
		if (next === width) return;
		event.preventDefault();
		onChange(next);
		onCommit?.(next);
	}
</script>

<!-- A focusable `separator` is a widget role, so the div is the correct host; the Svelte a11y
     rules only know the non-interactive reading of that role. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	role="separator"
	aria-orientation="vertical"
	aria-label={label}
	aria-valuemin={min}
	aria-valuemax={max}
	aria-valuenow={Math.round(width)}
	tabindex="0"
	title="{label} (drag or use the arrow keys)"
	data-testid={testId}
	class="cursor-col-resize touch-none bg-transparent hover:bg-sky-500/30 focus:bg-sky-500/50 focus:outline-none {className}"
	{style}
	onpointerdown={startDrag}
	onpointermove={moveDrag}
	onpointerup={endDrag}
	onpointercancel={endDrag}
	onkeydown={handleKeydown}
></div>
