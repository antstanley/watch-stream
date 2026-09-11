import { describe, expect, it } from 'vitest';
import {
	classifyCredentialFailure,
	describeStyle,
	isCredentialFailure,
	loginAdvice,
	readProfileStyle,
} from '../src/lib/cli/credentials.ts';

const SSO_CONFIG = `[profile acme-prod]
sso_session = acme
region = eu-west-1

[sso-session acme]
sso_start_url = https://acme.awsapps.com/start/#
sso_region = eu-west-1
`;

const LOGIN_CONFIG = `[profile console]
login_session = arn:aws:signin:::devtools/same-device
region = us-east-1
`;

const STATIC_CONFIG = `[profile keys]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = secret
`;

const PROCESS_CONFIG = `[profile deployed]
credential_process = /usr/local/bin/get-creds --profile deployed
`;

describe('readProfileStyle', () => {
	it('recognises SSO profiles, including through an sso-session', () => {
		expect(readProfileStyle(SSO_CONFIG, '', 'acme-prod')).toBe('sso');
		expect(
			readProfileStyle('[default]\nsso_start_url = https://x.awsapps.com/start', '', 'default'),
		).toBe('sso');
	});

	it('recognises console sign-in profiles', () => {
		expect(readProfileStyle(LOGIN_CONFIG, '', 'console')).toBe('login');
	});

	it('recognises static keys, in config or in the credentials file', () => {
		expect(readProfileStyle(STATIC_CONFIG, '', 'keys')).toBe('static');
		expect(
			readProfileStyle(
				'',
				'[other]\naws_access_key_id = AKIA\naws_secret_access_key = s\n',
				'other',
			),
		).toBe('static');
	});

	it('recognises credential_process profiles', () => {
		expect(readProfileStyle(PROCESS_CONFIG, '', 'deployed')).toBe('process');
	});

	it('reports unknown profiles as unconfigured', () => {
		expect(readProfileStyle(SSO_CONFIG, '', 'nope')).toBe('unconfigured');
		expect(readProfileStyle('[default]\nregion = us-west-1\n', '', 'default')).toBe('unconfigured');
	});
});

describe('classifyCredentialFailure', () => {
	it('spots an SSO session that needs logging in to', () => {
		expect(
			classifyCredentialFailure(
				"The SSO session token associated with profile=acme-prod was not found or is invalid. To refresh this SSO session run 'aws sso login'",
			),
		).toBe('sso-expired');
	});

	it('spots the console sign-in session the AWS CLI reports', () => {
		expect(classifyCredentialFailure('Your session has expired. Please reauthenticate.')).toBe(
			'missing',
		);
		expect(classifyCredentialFailure('Could not load credentials from any providers')).toBe(
			'missing',
		);
	});

	it('spots keys that are present but rejected', () => {
		expect(
			classifyCredentialFailure(
				'The security token included in the request is invalid.',
				'access-denied',
			),
		).toBe('unusable');
	});

	it('leaves unrelated failures alone', () => {
		expect(classifyCredentialFailure('No AWS region is configured.', 'missing-region')).toBe(
			'other',
		);
		expect(isCredentialFailure('missing-region', 'No AWS region is configured.')).toBe(false);
		expect(isCredentialFailure('missing-credentials', 'anything')).toBe(true);
	});
});

describe('loginAdvice', () => {
	it('runs `aws sso login` for SSO profiles', () => {
		expect(loginAdvice({ style: 'sso', failure: 'sso-expired', profile: 'acme-prod' })).toEqual({
			command: ['sso', 'login', '--profile', 'acme-prod'],
			hint: 'Sign in to the SSO session for acme-prod',
		});
	});

	it('runs `aws login` for console sign-in and unconfigured profiles', () => {
		expect(
			loginAdvice({ style: 'login', failure: 'missing', profile: 'console' })?.command,
		).toEqual(['login', '--profile', 'console']);
		expect(
			loginAdvice({ style: 'unconfigured', failure: 'missing', profile: null })?.command,
		).toEqual(['login']);
		expect(
			loginAdvice({ style: 'unconfigured', failure: 'missing', profile: 'default' })?.command,
		).toEqual(['login']);
	});

	it('adds --remote when there is no browser', () => {
		expect(
			loginAdvice({ style: 'sso', failure: 'sso-expired', profile: 'acme', remote: true })?.command,
		).toEqual(['sso', 'login', '--profile', 'acme', '--remote']);
	});

	it('refuses to suggest a login for static keys or a credential_process', () => {
		expect(loginAdvice({ style: 'static', failure: 'unusable', profile: 'keys' })).toBeNull();
		expect(loginAdvice({ style: 'process', failure: 'missing', profile: 'deployed' })).toBeNull();
	});

	it('never suggests `aws sso login` for a profile that is not SSO', () => {
		expect(
			loginAdvice({ style: 'login', failure: 'sso-expired', profile: 'console' })?.command[0],
		).toBe('login');
	});
});

describe('describeStyle', () => {
	it('explains each style', () => {
		expect(describeStyle('sso')).toBe('SSO');
		expect(describeStyle('static')).toBe('static access keys');
		expect(describeStyle('unconfigured')).toBe('no credentials');
	});
});
