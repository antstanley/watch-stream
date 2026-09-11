import { describe, expect, it } from 'vitest';
import { decide, firstPublishEntry } from '../scripts/release-plan.ts';

/** Plan shape produced by `changeset publish-plan`. */
function plan(version: string | null, tag = 'latest') {
	if (version === null) return { version: 1, plan: [] };
	return {
		version: 1,
		plan: [[{ kind: 'publish', name: 'watch-tail', version, access: 'public', tag }]],
	};
}

const never = () => false;
const always = () => true;

describe('firstPublishEntry', () => {
	it('finds the first publish entry', () => {
		expect(firstPublishEntry(plan('0.1.0'))?.version).toBe('0.1.0');
	});

	it('returns null for empty or malformed plans', () => {
		expect(firstPublishEntry(plan(null))).toBeNull();
		expect(firstPublishEntry({})).toBeNull();
		expect(
			firstPublishEntry({ plan: [[{ kind: 'tag', name: 'x', version: '1.0.0' }]] }),
		).toBeNull();
		expect(firstPublishEntry(null)).toBeNull();
	});
});

describe('decide', () => {
	it('publishes a fresh version', () => {
		expect(decide(plan('0.1.0'), never)).toEqual({
			publish: true,
			version: '0.1.0',
			distTag: 'latest',
			reason: 'ready to stage watch-tail@0.1.0 (dist-tag: latest)',
		});
	});

	it('reports the prerelease dist-tag', () => {
		expect(decide(plan('0.2.0-beta.1', 'beta'), never).distTag).toBe('beta');
	});

	it('skips an empty plan', () => {
		expect(decide(plan(null), never)).toMatchObject({
			publish: false,
			version: '',
			reason: 'no changesets release pending',
		});
	});

	it('skips main sitting at 0.0.0', () => {
		const result = decide(plan('0.0.0'), never);
		expect(result.publish).toBe(false);
		expect(result.reason).toContain('Version PR');
	});

	it('skips a version the registry already has', () => {
		const result = decide(plan('0.1.0'), always);
		expect(result.publish).toBe(false);
		expect(result.reason).toContain('already on the registry');
	});
});
