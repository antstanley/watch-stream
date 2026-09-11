/**
 * Turns a changesets publish plan into a release decision for GitHub Actions.
 *
 * `changeset publish-plan` answers "what is ready to publish or tag?" but it
 * cannot know about the registry, and it reports the version on main even when
 * that version was never released (0.0.0). This script adds those guards and
 * writes the result to `GITHUB_OUTPUT`, so the workflow stays free of inline
 * jq/shell quoting.
 *
 * Usage:
 *   node scripts/release-plan.ts --plan plan.json [--package watch-tail] [--no-registry-check]
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export type PublishEntry = {
	kind?: string;
	name?: string;
	version?: string;
	access?: string;
	tag?: string;
};

export type Decision = {
	publish: boolean;
	version: string;
	distTag: string;
	reason: string;
};

/** First publishable entry of a changesets plan, or `null`. */
export function firstPublishEntry(plan: unknown): PublishEntry | null {
	const groups = (plan as { plan?: unknown })?.plan;
	if (!Array.isArray(groups)) return null;
	for (const group of groups) {
		if (!Array.isArray(group)) continue;
		for (const entry of group as PublishEntry[]) {
			if (entry?.kind === 'publish') return entry;
		}
	}
	return null;
}

/**
 * Decides whether this commit has something to stage.
 *
 * `isPublished` is injected so the rule can be unit tested: a version that is
 * already on the registry is skipped, as is main's unreleased 0.0.0.
 */
export function decide(plan: unknown, isPublished: (version: string) => boolean): Decision {
	const entry = firstPublishEntry(plan);
	const version = entry?.version ?? '';
	const distTag = entry?.tag ?? 'latest';

	if (entry === null || version === '') {
		return { publish: false, version: '', distTag, reason: 'no changesets release pending' };
	}
	if (version === '0.0.0') {
		return {
			publish: false,
			version,
			distTag,
			reason: 'main is still at 0.0.0 - the Version PR has not been merged',
		};
	}
	if (isPublished(version)) {
		return {
			publish: false,
			version,
			distTag,
			reason: `watch-tail@${version} is already on the registry`,
		};
	}
	return {
		publish: true,
		version,
		distTag,
		reason: `ready to stage watch-tail@${version} (dist-tag: ${distTag})`,
	};
}

/** True when npm already has this exact version. */
export function isPublishedOnNpm(name: string, version: string): boolean {
	try {
		execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function main(argv: string[]): number {
	const value = (flag: string, fallback: string | null): string | null => {
		const index = argv.indexOf(flag);
		return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
	};
	const planPath = value('--plan', null);
	const name = value('--package', 'watch-tail') ?? 'watch-tail';
	const checkRegistry = !argv.includes('--no-registry-check');

	if (planPath === null) {
		console.error('release-plan: --plan <file> is required');
		return 2;
	}

	let plan: unknown;
	try {
		plan = JSON.parse(readFileSync(planPath, 'utf8'));
	} catch (error) {
		console.error(
			`release-plan: could not read ${planPath}: ${error instanceof Error ? error.message : error}`,
		);
		return 2;
	}

	const decision = decide(plan, (version) => checkRegistry && isPublishedOnNpm(name, version));
	console.log(decision.reason);

	const summary = [
		'## Changesets release decision',
		'',
		`- publish: ${String(decision.publish)}`,
		`- version: ${decision.version || 'none'}`,
		`- dist-tag: ${decision.distTag}`,
		'',
		decision.reason,
	].join('\n');
	console.log(summary);

	const outputFile = process.env.GITHUB_OUTPUT;
	if (typeof outputFile === 'string' && outputFile.length > 0) {
		appendFileSync(
			outputFile,
			`publish=${String(decision.publish)}\nversion=${decision.version}\ndist_tag=${decision.distTag}\n`,
		);
	}
	const summaryFile = process.env.GITHUB_STEP_SUMMARY;
	if (typeof summaryFile === 'string' && summaryFile.length > 0) {
		appendFileSync(summaryFile, `${summary}\n`);
	}
	return 0;
}

// Type-stripped by Node: the guard keeps `import` in tests from running main.
if (process.argv[1] !== undefined && process.argv[1].endsWith('release-plan.ts')) {
	process.exitCode = main(process.argv.slice(2));
}
