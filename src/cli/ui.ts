/**
 * Terminal presentation for the CLI.
 *
 * Interactive terminals get the Bombshell (`@clack/prompts`) experience -
 * banner, spinner, autocomplete prompts. Anything else (pipes, CI, `--no-color`)
 * falls back to plain lines, which also keeps the integration tests readable.
 */
import {
	autocomplete,
	cancel,
	confirm,
	intro,
	isCancel,
	log,
	outro,
	spinner,
} from '@clack/prompts';

export type Ui = {
	/** True when animated output and prompts are safe to use. */
	readonly interactive: boolean;
	intro(text: string): void;
	outro(text: string): void;
	info(text: string): void;
	warn(text: string): void;
	startSpinner(text: string): void;
	stopSpinner(text: string): void;
	failSpinner(text: string): void;
	/** Asks for a value from `options`; resolves `null` when cancelled or unavailable. */
	choose(
		message: string,
		options: { value: string; label?: string }[],
		initial?: string | null,
	): Promise<string | null>;
	/** Asks a yes/no question; a non-interactive run always answers `false`. */
	confirm(message: string, initial?: boolean): Promise<boolean>;
};

/** Decides whether the process can render animated output and ask questions. */
export function isInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') return false;
	if (env.WATCH_TAIL_PLAIN === '1') return false;
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
	return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/**
 * Builds the presentation layer.
 *
 * The non-interactive branch never touches `@clack/prompts`, so piping the CLI
 * into a file or a test harness produces stable, greppable output.
 */
export function createUi(options: { interactive?: boolean } = {}): Ui {
	const interactive = options.interactive ?? isInteractive();
	const spin = interactive ? spinner() : null;

	if (!interactive) {
		return {
			interactive,
			intro: (text) => console.log(text),
			outro: (text) => console.log(text),
			info: (text) => console.log(text),
			warn: (text) => console.warn(`warning: ${text}`),
			startSpinner: (text) => console.log(text),
			stopSpinner: (text) => console.log(text),
			failSpinner: (text) => console.error(text),
			choose: async (_message, choices, initial) => {
				const fallback = initial ?? choices[0]?.value ?? null;
				return fallback;
			},
			confirm: async () => false,
		};
	}

	return {
		interactive,
		intro: (text) => intro(text),
		outro: (text) => outro(text),
		info: (text) => log.info(text),
		warn: (text) => log.warn(text),
		startSpinner: (text) => spin?.start(text),
		stopSpinner: (text) => spin?.stop(text),
		failSpinner: (text) => {
			spin?.stop();
			log.error(text);
		},
		choose: async (message, choices, initial) => {
			if (choices.length === 0) return null;
			const answer = await autocomplete({
				message,
				options: choices.map((choice) => ({
					value: choice.value,
					label: choice.label ?? choice.value,
				})),
				initialValue: initial ?? undefined,
				maxItems: 12,
			});
			if (isCancel(answer)) {
				cancel('Cancelled.');
				return null;
			}
			return String(answer);
		},
		confirm: async (message, initial = true) => {
			const answer = await confirm({ message, initialValue: initial });
			if (isCancel(answer)) return false;
			return answer === true;
		},
	};
}
