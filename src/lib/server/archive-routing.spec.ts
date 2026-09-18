import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { getArchive, loadDuckDbDriver, resetArchive } from './archive';
import { ArchiveLocator } from './archive-location';

const installed = await loadDuckDbDriver().then(
	() => true,
	() => false,
);

test.skipIf(!installed)(
	'routes identical event IDs into independent files and reuses handles',
	async () => {
		const root = mkdtempSync(join(tmpdir(), 'watch-tail-routing-'));
		const locate = vi
			.spyOn(ArchiveLocator.prototype, 'locate')
			.mockImplementation(async (_base, env, selection) =>
				join(
					root,
					env.AWS_PROFILE ?? 'account-a',
					selection.region ?? 'eu-west-1',
					'archive.duckdb',
				),
			);
		resetArchive();
		const env = { WATCH_TAIL_ARCHIVE: 'on', AWS_PROFILE: 'account-a' };
		const handles = [];
		try {
			const [first, same, otherRegion, otherAccount] = await Promise.all([
				getArchive(env, { region: 'eu-west-1' }),
				getArchive(env, { region: 'eu-west-1' }),
				getArchive(env, { region: 'us-east-1' }),
				getArchive({ ...env, AWS_PROFILE: 'account-b' }, { region: 'eu-west-1' }),
			]);
			handles.push(first, otherRegion, otherAccount);
			expect(first).toBe(same);
			for (const [index, archive] of handles.entries()) {
				expect(archive.available).toBe(true);
				await archive.record(index === 1 ? 'us-east-1' : 'eu-west-1', '/same-group', [
					{ id: 'same-event-id', timestamp: 1000, message: `archive-${index}` },
				]);
			}
			for (const [index, archive] of handles.entries()) {
				const page = await archive.page({
					region: index === 1 ? 'us-east-1' : 'eu-west-1',
					logGroups: ['/same-group'],
					startTime: 0,
					endTime: 2000,
					limit: 100,
				});
				expect(page.events.map((event) => event.message)).toEqual([`archive-${index}`]);
			}
			const explicit = await getArchive(
				{ ...env, WATCH_TAIL_ARCHIVE_DB: first.path },
				{ region: 'us-east-1' },
			);
			expect(explicit).toBe(first);
			const calls = locate.mock.calls.length;
			const disabled = await getArchive({ WATCH_TAIL_ARCHIVE: 'off' });
			expect(disabled.available).toBe(false);
			expect(locate).toHaveBeenCalledTimes(calls);
		} finally {
			await Promise.all(handles.map((archive) => archive.close()));
			resetArchive();
			locate.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
