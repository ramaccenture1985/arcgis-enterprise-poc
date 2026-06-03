/**
 * Centralised resource naming so that independent stacks (e.g. SecurityStack
 * granting IAM permissions, DataStack creating the bucket) agree on names
 * without a cross-stack dependency.
 */

export type BucketKind = 'object-store' | 'image-store' | 'datastore-backup' | 'access-logs';

/**
 * Deterministic, globally-unique S3 bucket name.
 * Pattern: xyz-esri-<env>-<kind>-<account>-<region>
 */
export function bucketName(
  envName: string,
  kind: BucketKind,
  account: string,
  region: string,
): string {
  return `xyz-esri-${envName}-${kind}-${account}-${region}`.toLowerCase();
}

/** Wildcard ARN for granting IAM access to a bucket + its objects. */
export function bucketArns(
  envName: string,
  kind: BucketKind,
  account: string,
  region: string,
): { bucket: string; objects: string } {
  const name = bucketName(envName, kind, account, region);
  return { bucket: `arn:aws:s3:::${name}`, objects: `arn:aws:s3:::${name}/*` };
}
