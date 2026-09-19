/** Keep whole trailing path segments, then the trailing characters of an oversized leaf. */
export function compactGroupName(
	name: string,
	width: number,
	measure: (text: string) => number,
): string {
	if (measure(name) <= width) return name;
	const parts = name.split('/');
	for (let start = 1; start < parts.length; start += 1) {
		const candidate = `../${parts.slice(start).join('/')}`;
		if (measure(candidate) <= width) return candidate;
	}
	const chars = Array.from(parts.at(-1) || name);
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (measure(`..${chars.slice(-middle).join('')}`) <= width) low = middle;
		else high = middle - 1;
	}
	return low === 0 ? '..' : `..${chars.slice(-low).join('')}`;
}

let context: CanvasRenderingContext2D | null = null;

/** Svelte action: remeasure when the sidebar or its badges change the available space. */
export function fitGroupName(node: HTMLElement, name: string) {
	let disposed = false;
	function update() {
		if (disposed || node.clientWidth === 0) return;
		context ??= document.createElement('canvas').getContext('2d');
		if (context === null) return;
		context.font = getComputedStyle(node).font;
		const measuring = context;
		node.textContent = compactGroupName(
			name,
			node.clientWidth,
			(text) => measuring.measureText(text).width,
		);
	}
	const observer = new ResizeObserver(update);
	observer.observe(node);
	void document.fonts?.ready.then(update);
	return {
		update(next: string) {
			name = next;
			update();
		},
		destroy() {
			disposed = true;
			observer.disconnect();
		},
	};
}
