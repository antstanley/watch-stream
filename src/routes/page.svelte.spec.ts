import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from './+page.svelte';

/**
 * Page-level tests for the CloudWatch/archive switch.
 *
 * `$app/state` and `$app/navigation` are mocked, `fetch` answers the four API routes and a fake
 * `EventSource` records the stream URLs, so the whole page can be driven without a server and
 * without touching a real archive.
 *
 * The file is not `+`-prefixed: SvelteKit reserves those names inside `src/routes`.
 */

const mocks = vi.hoisted(() => ({
	url: new URL('http://localhost:5173/'),
	replaceState: vi.fn<(url: URL, state: unknown) => void>(),
}));

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return mocks.url;
		},
	},
}));

vi.mock('$app/navigation', () => ({
	replaceState: (url: URL, state: unknown) => mocks.replaceState(url, state),
}));

/** Minimal `EventSource` double that records the URLs the page opens. */
class FakeEventSource {
	static urls: string[] = [];

	readonly url: string;
	readyState = 0;

	constructor(url: string) {
		this.url = url;
		FakeEventSource.urls.push(url);
	}

	addEventListener(): void {
		// The page only needs the connection to exist.
	}

	removeEventListener(): void {
		// Nothing to detach in this double.
	}

	close(): void {
		this.readyState = 2;
	}
}

/** Archive availability the stubbed `/api/archive` answers with. */
let archiveAvailable = true;
/** Every URL the page fetched, in order. */
let requested: string[] = [];

/** Answers the API routes the page calls during bootstrap. */
function stubApi(input: string): Promise<Response> {
	requested.push(input);
	const url = new URL(input, 'http://localhost');
	const source = url.searchParams.get('source') === 'archive' ? 'archive' : 'cloudwatch';

	if (url.pathname === '/api/regions') {
		return json({
			regions: ['us-east-1', 'eu-west-1'],
			defaultRegion: 'us-east-1',
			endpoint: null,
		});
	}
	if (url.pathname === '/api/health') {
		return json({
			ok: true,
			region: 'us-east-1',
			endpoint: null,
			local: false,
			credentials: 'ambient',
		});
	}
	if (url.pathname === '/api/archive') {
		return json({
			path: '/tmp/watch-tail/archive.duckdb',
			available: archiveAvailable,
			error: archiveAvailable ? null : 'Cannot find module @duckdb/node-api',
			bytes: archiveAvailable ? 4096 : null,
			rows: 3,
			groups: 1,
			regions: 1,
			oldest: archiveAvailable ? 1000 : null,
			newest: archiveAvailable ? 2000 : null,
		});
	}
	if (url.pathname === '/api/log-groups') {
		const groups =
			source === 'archive'
				? [{ name: '/aws/archived', archivedEvents: 12 }]
				: [{ name: '/aws/app', storedBytes: 2048 }];
		return json({ region: 'us-east-1', endpoint: null, source, groups });
	}
	return Promise.resolve(new Response('not found', { status: 404 }));
}

/** JSON response for the stubbed API. */
function json(body: unknown): Promise<Response> {
	return Promise.resolve(
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		}),
	);
}

/** Points the mocked `page.url` at a query string. */
function setUrl(search = ''): void {
	mocks.url = new URL(`http://localhost:5173/${search}`);
}

/** Renders the page and waits for the group list of the first load. */
async function renderPage(): Promise<void> {
	render(Page);
	await waitFor(() => expect(requested.some((url) => url.includes('/api/log-groups'))).toBe(true));
	await waitFor(() => expect(screen.queryByTestId('group-loading')).toBeNull());
}

/** Last URL written through `replaceState`. */
function lastUrl(): URL {
	const call = mocks.replaceState.mock.calls.at(-1);
	if (call === undefined) throw new Error('replaceState was never called');
	return call[0];
}

beforeEach(() => {
	archiveAvailable = true;
	requested = [];
	FakeEventSource.urls = [];
	mocks.replaceState.mockClear();
	setUrl();
	vi.stubGlobal('fetch', vi.fn(stubApi));
	vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('page source switch', () => {
	it('hides the archive toggle while the archive is unavailable', async () => {
		archiveAvailable = false;
		setUrl('?region=us-east-1&group=/aws/app');

		await renderPage();

		expect(screen.queryByTestId('source-archive')).toBeNull();
		expect(screen.queryByTestId('source-cloudwatch')).toBeNull();
		expect(screen.queryByTestId('archive-note')).toBeNull();
		expect(screen.queryByTestId('archive-source-badge')).toBeNull();
		// The CloudWatch list is untouched: one row, no archive badge.
		const rows = screen.getAllByTestId('group-row');
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain('/aws/app');
		expect(screen.queryAllByTestId('group-archived-count')).toHaveLength(0);
		expect(requested.some((url) => url.includes('source=archive'))).toBe(false);
	});

	it('offers the toggle once the archive is available', async () => {
		await renderPage();

		expect(screen.getByTestId('source-cloudwatch').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('source-archive').getAttribute('aria-pressed')).toBe('false');
		const archive = screen.getByTestId('source-archive');
		expect(archive.getAttribute('title')).toContain('/tmp/watch-tail/archive.duckdb');
	});

	it('switches the list and the stream to the archive and mirrors source=archive in the URL', async () => {
		setUrl('?region=us-east-1&group=/aws/app');
		await renderPage();

		await fireEvent.click(screen.getByTestId('source-archive'));

		await waitFor(() => expect(lastUrl().searchParams.get('source')).toBe('archive'));
		// The archive is historic-only, whatever the view was before.
		expect(lastUrl().searchParams.get('mode')).toBe('historic');
		expect(lastUrl().searchParams.get('group')).toBe('/aws/app');
		expect(screen.getByTestId('mode-historic').getAttribute('aria-pressed')).toBe('true');

		// The stream restarts against the archive for the selected group.
		await waitFor(() => {
			const stream = FakeEventSource.urls.at(-1) ?? '';
			expect(stream).toContain('source=archive');
			expect(stream).toContain('mode=historic');
			expect(stream).toContain('group=%2Faws%2Fapp');
		});

		// The group list comes from the archive now.
		await waitFor(() => expect(screen.getAllByTestId('group-archived-count')).toHaveLength(1));
		expect(screen.getByTestId('group-archived-count').textContent?.trim()).toBe('12 archived');
		expect(requested.some((url) => url.includes('source=archive'))).toBe(true);
		expect(screen.getByTestId('archive-source-badge')).toBeTruthy();
		expect(screen.getByTestId('archive-note')).toBeTruthy();
	});

	it('ignores live while the archive is the source', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive');
		await renderPage();

		expect(screen.getByTestId('source-archive').getAttribute('aria-pressed')).toBe('true');
		const streams = FakeEventSource.urls.length;

		await fireEvent.click(screen.getByTestId('mode-live'));

		expect(screen.getByTestId('mode-historic').getAttribute('aria-pressed')).toBe('true');
		expect(FakeEventSource.urls).toHaveLength(streams);
		expect(lastUrl().searchParams.get('source')).toBe('archive');
	});

	it('switches back to CloudWatch and drops the parameter again', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive');
		await renderPage();

		await fireEvent.click(screen.getByTestId('source-cloudwatch'));

		await waitFor(() => expect(lastUrl().searchParams.get('source')).toBeNull());
		await waitFor(() => {
			const stream = FakeEventSource.urls.at(-1) ?? '';
			expect(stream).toContain('group=%2Faws%2Fapp');
			expect(stream).not.toContain('source=archive');
		});
		// The CloudWatch list is back: plain sizes, no archive badge.
		await waitFor(() => expect(screen.queryByTestId('group-archived-count')).toBeNull());
		await waitFor(() => expect(screen.queryByTestId('archive-source-badge')).toBeNull());
		expect(screen.queryByTestId('group-source-badge')).toBeNull();
		expect(screen.getByText('Log groups')).toBeTruthy();
	});

	it('restores the archive view from the URL but falls back when it is unavailable', async () => {
		archiveAvailable = false;
		setUrl('?region=us-east-1&group=/aws/app&source=archive');

		await renderPage();

		expect(screen.queryByTestId('source-archive')).toBeNull();
		expect(lastUrl().searchParams.get('source')).toBeNull();
		expect(FakeEventSource.urls.some((url) => url.includes('source=archive'))).toBe(false);
		const rows = screen.getAllByTestId('group-row');
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain('/aws/app');
	});
});
