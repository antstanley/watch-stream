/**
 * Regions offered by the picker when `WATCH_TAIL_REGIONS` is not set.
 *
 * The list is every AWS region in the standard `aws` partition that publishes a
 * CloudWatch Logs endpoint, taken from the AWS CLI's own endpoint data
 * (`botocore/data/endpoints.json`, filtered to the `aws` partition and with the
 * FIPS pseudo-regions removed). `af-south-1` (Africa, Cape Town) is included.
 * The China, GovCloud and secret partitions are excluded on purpose.
 *
 * Shared by the server (`src/lib/server/regions.ts`) and the browser
 * (`src/lib/groups-client.ts`) so both agree on the same set.
 * Narrow it per deployment with `WATCH_TAIL_REGIONS=eu-west-1,af-south-1`.
 */
export const REGION_CODES: readonly string[] = [
	'us-east-1',
	'us-east-2',
	'us-west-1',
	'us-west-2',
	'ca-central-1',
	'ca-west-1',
	'mx-central-1',
	'sa-east-1',
	'eu-west-1',
	'eu-west-2',
	'eu-west-3',
	'eu-central-1',
	'eu-central-2',
	'eu-north-1',
	'eu-south-1',
	'eu-south-2',
	'af-south-1',
	'me-south-1',
	'me-central-1',
	'il-central-1',
	'ap-east-1',
	'ap-south-1',
	'ap-south-2',
	'ap-southeast-1',
	'ap-southeast-2',
	'ap-southeast-3',
	'ap-southeast-4',
	'ap-southeast-5',
	'ap-southeast-6',
	'ap-southeast-7',
	'ap-northeast-1',
	'ap-northeast-2',
	'ap-northeast-3',
];
