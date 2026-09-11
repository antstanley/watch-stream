/**
 * Credential diagnosis for the CLI: why AWS is refusing, and which login command
 * fixes it.
 *
 * The app itself reports the failure (`/api/log-groups` answers 502 with a code
 * such as `missing-credentials`), so this module only has to answer the second
 * half of the question: what should the user run? That depends on how the
 * profile is configured, which is read from the user's own AWS files.
 */

/** How a profile gets its credentials. */
export type ProfileStyle = 'sso' | 'login' | 'static' | 'process' | 'unconfigured';

/** Why the AWS call failed, as far as the CLI can tell. */
export type CredentialFailure = 'sso-expired' | 'missing' | 'unusable' | 'other';

/** A command the user can run to fix the problem. */
export type LoginAdvice = {
	/** argv, without the leading `aws`. */
	command: string[];
	/** One line explaining what will happen. */
	hint: string;
	/** Set when the failure and the profile style disagree. */
	note?: string;
};

/** `true` when the failure is about credentials rather than about the region or the API. */
export function isCredentialFailure(code: string | undefined, message: string): boolean {
	if (code === 'missing-credentials' || code === 'access-denied') return true;
	return /credential|expired|sso|sign in|sign-in|reauthenticate|not authorized|unrecognized client/i.test(
		message,
	);
}

/**
 * Classifies the message the SDK produced.
 *
 * The three shapes that matter come from the AWS CLI's own providers: an SSO
 * session that needs `aws sso login`, a console sign-in session that needs
 * `aws login`, and static keys that are simply wrong.
 */
export function classifyCredentialFailure(message: string, code?: string): CredentialFailure {
	if (/sso login|sso session|sso token/i.test(message)) return 'sso-expired';
	if (/reauthenticate|sign in|sign-in|login session/i.test(message)) return 'missing';
	if (/could not load credentials|unable to locate credentials|no credentials/i.test(message)) {
		return 'missing';
	}
	if (
		code === 'access-denied' ||
		/invalidclienttoken|unrecognizedclient|invalid signature|forbidden/i.test(message)
	) {
		return 'unusable';
	}
	return code === 'missing-credentials' ? 'missing' : 'other';
}

/** Splits an ini-style file into `section -> lines`. */
function sections(text: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	let current: string | null = null;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header !== null) {
			current = header[1].trim();
			if (!map.has(current)) map.set(current, []);
			continue;
		}
		if (current !== null) map.get(current)?.push(line);
	}
	return map;
}

/** Normalises a profile's section name: `[profile x]` in config, `[x]` in credentials. */
function sectionNames(profile: string): string[] {
	return profile === 'default' ? ['default', 'profile default'] : [profile, `profile ${profile}`];
}

/** The profile's lines from whichever file defines it first. */
function profileLines(configText: string, credentialsText: string, profile: string): string[] {
	for (const text of [configText, credentialsText]) {
		const map = sections(text);
		for (const name of sectionNames(profile)) {
			const lines = map.get(name);
			if (lines !== undefined) return lines;
		}
	}
	return [];
}

/** Reads a `key = value` setting from a profile's lines. */
function setting(lines: string[], key: string): string | null {
	const pattern = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'i');
	for (const line of lines) {
		const match = pattern.exec(line);
		if (match !== null) {
			const value = match[1].trim();
			if (value.length > 0) return value;
		}
	}
	return null;
}

/**
 * Works out how a profile authenticates.
 *
 * Order matters: `sso_session` and `login_session` are the modern providers, and
 * a profile that has both (it should not) is treated as SSO because that is the
 * one `aws sso login` repairs.
 */
export function readProfileStyle(
	configText: string,
	credentialsText: string,
	profile: string,
): ProfileStyle {
	const lines = profileLines(configText, credentialsText, profile);
	if (lines.length === 0) {
		const configured = [...sections(configText).keys()].some((name) => name.startsWith('profile '));
		return configured ? 'unconfigured' : 'unconfigured';
	}
	if (setting(lines, 'sso_session') !== null || setting(lines, 'sso_start_url') !== null)
		return 'sso';
	if (setting(lines, 'login_session') !== null) return 'login';
	if (setting(lines, 'credential_process') !== null) return 'process';
	if (setting(lines, 'aws_access_key_id') !== null) return 'static';
	return 'unconfigured';
}

/**
 * Picks the login command for a failure.
 *
 * Returns `null` when no login command applies: static keys are fixed with
 * `aws configure`, and a `credential_process` has to be debugged in place.
 * `aws login` also refuses to convert a profile that already uses another style,
 * which is why the style is checked before suggesting it.
 */
export function loginAdvice(input: {
	style: ProfileStyle;
	failure: CredentialFailure;
	profile: string | null;
	/** True when there is no browser available (SSH, no display). */
	remote?: boolean;
}): LoginAdvice | null {
	const { style, failure, profile, remote = false } = input;
	const named = profile !== null && profile !== 'default';
	const remoteFlag = remote ? ['--remote'] : [];

	// The profile's own style decides the command. A failure message that
	// mentions SSO while the profile is not SSO-configured must not send anyone
	// to `aws sso login`: AWS rejects that with "Missing the following required
	// SSO configuration values" (verified against the real CLI).
	if (style === 'sso') {
		return {
			command: ['sso', 'login', ...(named ? ['--profile', profile] : []), ...remoteFlag],
			hint: named
				? `Sign in to the SSO session for ${profile}`
				: 'Sign in to the default SSO session',
		};
	}

	if (style === 'login' || style === 'unconfigured') {
		// `aws login` also creates the session, so it is the right answer for a
		// profile that has no credentials configured yet.
		const mismatch = failure === 'sso-expired';
		return {
			command: ['login', ...(named ? ['--profile', profile] : []), ...remoteFlag],
			hint: named
				? `Sign in to the AWS console and save the session in ${profile}`
				: 'Sign in to the AWS console and save the session in the default profile',
			...(mismatch ? { note: 'the SSO session that failed belongs to a different profile' } : {}),
		};
	}

	// Static keys are fixed with `aws configure`; a credential_process has to be
	// debugged where it is defined.
	return null;
}

/** One-line description of a style, for messages. */
export function describeStyle(style: ProfileStyle): string {
	switch (style) {
		case 'sso':
			return 'SSO';
		case 'login':
			return 'console sign-in';
		case 'static':
			return 'static access keys';
		case 'process':
			return 'a credential_process';
		default:
			return 'no credentials';
	}
}
