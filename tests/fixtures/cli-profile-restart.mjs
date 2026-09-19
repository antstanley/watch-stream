// Exercise the real UI, child server, profile restart and stop handler. Only
// AWS responses are replaced, so this never needs credentials or a login.
const entry = new URL('../../dist/cli/index.js', import.meta.url).href;
const { run } = await import(entry);
const [port, verbose] = process.argv.slice(2);
process.exitCode = await run(
	['--no-open', '--no-archive', '--port', port, ...(verbose === 'true' ? ['--verbose'] : [])],
	{
		env: {
			...process.env,
			AWS_EC2_METADATA_DISABLED: 'true',
			AWS_PROFILE: '',
			AWS_REGION: 'us-east-1',
			AWS_ACCESS_KEY_ID: 'test',
			AWS_SECRET_ACCESS_KEY: 'test',
		},
		interactive: true,
		readProfiles: () => ['default', 'test-profile'],
		readConfigText: () => '[profile test-profile]\nregion=us-east-1\n',
		readLocalEnvValues: () => ({}),
		probeCredentials: async () => ({
			ok: false,
			credentialProblem: true,
			code: 'ExpiredTokenException',
			message: 'Your session has expired. Please reauthenticate.',
		}),
		readIdentity: async () => ({
			ok: true,
			identity: {
				arn: 'arn:aws:iam::000000000000:user/test',
				account: '000000000000',
				userId: 'test',
			},
		}),
	},
);
