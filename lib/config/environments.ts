/**
 * Per-environment configuration for the XYZ Agotest Risk Platform ArcGIS Enterprise
 * deployment.
 *
 * Environment list: dev / test / uat / prod / dr.
 *   - dev/test/uat/prod CIDRs come from the LLD "VPC CIDR allocation" (Table 3).
 *   - dr is added per the HLD (preferred over the LLD on conflicts). DR mirrors
 *     the Production configuration in its own VPC; CIDR 10.0.64.0/20 continues
 *     the LLD's /20-per-environment scheme.
 *
 * Instance sizing follows the LLD "EC2 instance type selection" (Table 30) for
 * prod / uat / dr. dev and test use reduced sizes per the LLD note that
 * "Development and Test may use reduced instance sizes" (section 6.1 / 2.3).
 */

import { InstanceType } from 'aws-cdk-lib/aws-ec2';

export type EnvName = 'dev' | 'test' | 'uat' | 'prod' | 'dr';

/** Logical compute component -> the instance type used in this environment. */
export interface ComputeSizing {
  readonly webAdaptorPortal: InstanceType;
  readonly portal: InstanceType;
  readonly webAdaptorServer: InstanceType;
  readonly arcgisServer: InstanceType;
  readonly webAdaptorImage: InstanceType;
  readonly imageServer: InstanceType;
  readonly notebookServer: InstanceType;
  readonly dataStore: InstanceType;
  readonly configStore: InstanceType;
  readonly monitor: InstanceType;
  readonly bastion: InstanceType;
}

export interface DatabaseSizing {
  /** RDS PostgreSQL instance class, e.g. "db.m6i.xlarge". */
  readonly rdsInstanceClass: string;
  /** Allocated storage (GiB). */
  readonly rdsAllocatedStorageGib: number;
  /** Max autoscaling storage (GiB) - LLD 7.2.1 enables storage autoscaling. */
  readonly rdsMaxAllocatedStorageGib: number;
}

/** Optional self-managed Active Directory config required by FSx for Windows. */
export interface ActiveDirectoryConfig {
  readonly domainName: string;
  readonly dnsIps: string[];
  readonly fileSystemAdministratorsGroup?: string;
  readonly organizationalUnitDistinguishedName?: string;
  /** Secrets Manager ARN holding the AD service account credentials. */
  readonly serviceAccountSecretArn: string;
}

export interface EnvironmentConfig {
  readonly name: EnvName;
  /** Whether this environment is "production-grade" (full size, deletion protection). */
  readonly productionGrade: boolean;
  /** VPC CIDR (/20). */
  readonly vpcCidr: string;
  /** AWS account id (filled from CDK env / context at deploy time if omitted). */
  readonly account?: string;
  /** AWS region - HLD section 6.1 specifies ap-southeast-2. */
  readonly region: string;
  /** The two AZ names used (AZ-a, AZ-b). */
  readonly availabilityZones: [string, string];
  /** Internal DNS domain for the Route 53 private hosted zone (LLD 5.8). */
  readonly internalDomain: string;
  /** Public DNS domain used for ACM certificates / Route 53 alias (LLD 4.1.1). */
  readonly publicDomain?: string;
  /** Whether to deploy AWS Network Firewall + inspection routing (LLD 5.4). */
  readonly deployNetworkFirewall: boolean;
  /** Whether to deploy FSx for Windows (requires AD - LLD 7.2.2). */
  readonly deployFsx: boolean;
  /** AD config for FSx; required when deployFsx is true. */
  readonly activeDirectory?: ActiveDirectoryConfig;
  /** Enable RDS Multi-AZ + read replica (LLD 7.x). */
  readonly rdsMultiAz: boolean;
  readonly rdsReadReplica: boolean;
  /** Enable deletion protection on stateful resources (LLD load-balancer/RDS tables). */
  readonly deletionProtection: boolean;
  readonly compute: ComputeSizing;
  readonly database: DatabaseSizing;
}

const AZ_A = 'ap-southeast-2a';
const AZ_B = 'ap-southeast-2b';

function it(type: string): InstanceType {
  return new InstanceType(type);
}

/** Production / UAT / DR baseline sizing - LLD Table 30. */
const FULL_SIZE: ComputeSizing = {
  webAdaptorPortal: it('m6i.large'),
  portal: it('m6i.xlarge'),
  webAdaptorServer: it('m6i.large'),
  arcgisServer: it('m6i.2xlarge'),
  webAdaptorImage: it('m6i.large'),
  imageServer: it('c6i.2xlarge'),
  notebookServer: it('m6i.2xlarge'),
  dataStore: it('r6i.xlarge'),
  configStore: it('m6i.large'),
  monitor: it('m6i.large'),
  bastion: it('m6i.large'),
};

/**
 * PoC sizing for dev / test - same architecture, minimal burstable instances
 * sized only to install and run the ArcGIS software for a proof of concept.
 * Core components sit at 8 GiB (Esri's minimum RAM for Portal / Server / Data
 * Store); ancillary roles use 4 GiB; the Bastion uses 2 GiB. t3 (burstable) is
 * fine for a PoC but not recommended for sustained production load.
 */
const REDUCED_SIZE: ComputeSizing = {
  webAdaptorPortal: it('t3.medium'), // 2 vCPU / 4 GiB - lightweight IIS reverse proxy
  portal: it('t3.large'), // 2 vCPU / 8 GiB - Esri minimum
  webAdaptorServer: it('t3.medium'),
  arcgisServer: it('t3.large'),
  webAdaptorImage: it('t3.medium'),
  imageServer: it('t3.large'),
  notebookServer: it('t3.large'),
  dataStore: it('t3.large'),
  configStore: it('t3.medium'),
  monitor: it('t3.medium'),
  bastion: it('t3.small'), // 2 vCPU / 2 GiB - RDP jump host only
};

const FULL_DB: DatabaseSizing = {
  rdsInstanceClass: 'db.m6i.xlarge',
  rdsAllocatedStorageGib: 200,
  rdsMaxAllocatedStorageGib: 1024,
};

// PoC database sizing for dev / test.
const REDUCED_DB: DatabaseSizing = {
  rdsInstanceClass: 'db.t3.medium',
  rdsAllocatedStorageGib: 50,
  rdsMaxAllocatedStorageGib: 100,
};

const REGION = 'ap-southeast-2';

export const ENVIRONMENTS: Record<EnvName, EnvironmentConfig> = {
  dev: {
    name: 'dev',
    productionGrade: false,
    vpcCidr: '10.0.0.0/20',
    region: REGION,
    availabilityZones: [AZ_A, AZ_B],
    internalDomain: 'dev.arcgis.internal',
    deployNetworkFirewall: false,
    deployFsx: false,
    rdsMultiAz: false,
    rdsReadReplica: false,
    deletionProtection: false,
    compute: REDUCED_SIZE,
    database: REDUCED_DB,
  },
  test: {
    name: 'test',
    productionGrade: false,
    vpcCidr: '10.0.16.0/20',
    region: REGION,
    availabilityZones: [AZ_A, AZ_B],
    internalDomain: 'test.arcgis.internal',
    deployNetworkFirewall: false,
    deployFsx: false,
    rdsMultiAz: false,
    rdsReadReplica: false,
    deletionProtection: false,
    compute: REDUCED_SIZE,
    database: REDUCED_DB,
  },
  uat: {
    name: 'uat',
    productionGrade: true,
    vpcCidr: '10.0.32.0/20',
    region: REGION,
    availabilityZones: [AZ_A, AZ_B],
    internalDomain: 'uat.arcgis.internal',
    deployNetworkFirewall: true,
    deployFsx: false,
    rdsMultiAz: true,
    rdsReadReplica: true,
    deletionProtection: true,
    compute: FULL_SIZE,
    database: FULL_DB,
  },
  prod: {
    name: 'prod',
    productionGrade: true,
    vpcCidr: '10.0.48.0/20',
    region: REGION,
    availabilityZones: [AZ_A, AZ_B],
    internalDomain: 'prod.arcgis.internal',
    deployNetworkFirewall: true,
    deployFsx: false,
    rdsMultiAz: true,
    rdsReadReplica: true,
    deletionProtection: true,
    compute: FULL_SIZE,
    database: FULL_DB,
  },
  // DR: HLD-driven environment (not in the LLD CIDR table). Mirrors Production.
  dr: {
    name: 'dr',
    productionGrade: true,
    vpcCidr: '10.0.64.0/20',
    region: REGION,
    availabilityZones: [AZ_A, AZ_B],
    internalDomain: 'dr.arcgis.internal',
    deployNetworkFirewall: true,
    deployFsx: false,
    rdsMultiAz: true,
    rdsReadReplica: true,
    deletionProtection: true,
    compute: FULL_SIZE,
    database: FULL_DB,
  },
};

export function getEnvironment(name: string): EnvironmentConfig {
  const key = name.toLowerCase() as EnvName;
  const cfg = ENVIRONMENTS[key];
  if (!cfg) {
    throw new Error(
      `Unknown environment "${name}". Valid values: ${Object.keys(ENVIRONMENTS).join(', ')}`,
    );
  }
  return cfg;
}
