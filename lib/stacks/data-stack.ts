import { Stack, StackProps, Tags, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import * as kms from 'aws-cdk-lib/aws-kms';
import { EnvironmentConfig } from '../config/environments';
import { EsriVpc } from '../constructs/esri-vpc';
import { SecurityGroups } from '../constructs/security-groups';
import { bucketName } from '../config/naming';

export interface DataStackProps extends StackProps {
  readonly envConfig: EnvironmentConfig;
  readonly esriVpc: EsriVpc;
  readonly securityGroups: SecurityGroups;
  readonly kmsKey: kms.IKey;
}

/**
 * DataStack provisions the persistence tier (LLD section 7):
 *   - RDS PostgreSQL (Enterprise Geodatabase) - Multi-AZ + read replica
 *   - FSx for Windows (config stores Drive 1, File Data Store Drive 2) - AD-gated
 *   - S3 buckets: Object Store, Image Server cloud store, Data Store backup,
 *     and load-balancer access logs
 *
 * Storage-at-rest is encrypted with the per-environment CMK. Backup schedule and
 * retention (section 7.3) are reflected in RDS PITR/retention and S3 lifecycle.
 */
export class DataStack extends Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly readReplica?: rds.DatabaseInstanceReadReplica;
  public readonly objectStoreBucket: s3.Bucket;
  public readonly imageStoreBucket: s3.Bucket;
  public readonly dataStoreBackupBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const env = props.envConfig;
    const v = props.esriVpc;
    const sg = props.securityGroups;
    const removalPolicy = env.productionGrade ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const isolatedSubnets: ec2.SubnetSelection = {
      subnets: v.subnetsFor(['isolated-data-az-a', 'isolated-data-az-b']),
    };

    // --- RDS PostgreSQL (Enterprise Geodatabase) : LLD 7.3.2 ---
    this.database = new rds.DatabaseInstance(this, 'EnterpriseGeodatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of('15.18', '15'),
      }),
      instanceType: new ec2.InstanceType(env.database.rdsInstanceClass.replace('db.', '')),
      vpc: v.vpc,
      vpcSubnets: isolatedSubnets,
      securityGroups: [sg.sg('sg-rds')],
      multiAz: env.rdsMultiAz,
      allocatedStorage: env.database.rdsAllocatedStorageGib,
      maxAllocatedStorage: env.database.rdsMaxAllocatedStorageGib, // storage autoscaling (7.2.1)
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: props.kmsKey,
      credentials: rds.Credentials.fromGeneratedSecret('arcgis_sde', {
        secretName: `${env.name}/esri/rds-master`,
        encryptionKey: props.kmsKey,
      }),
      databaseName: 'sde',
      backupRetention: Duration.days(7), // PITR within 7-day window (7.3.2)
      deleteAutomatedBackups: !env.productionGrade,
      deletionProtection: env.deletionProtection,
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      removalPolicy,
      instanceIdentifier: `${env.name}-esri-geodatabase`,
    });

    if (env.rdsReadReplica) {
      this.readReplica = new rds.DatabaseInstanceReadReplica(this, 'GeodatabaseReadReplica', {
        sourceDatabaseInstance: this.database,
        instanceType: new ec2.InstanceType(env.database.rdsInstanceClass.replace('db.', '')),
        vpc: v.vpc,
        vpcSubnets: isolatedSubnets,
        securityGroups: [sg.sg('sg-rds-replica')],
        storageEncrypted: true,
        storageEncryptionKey: props.kmsKey,
        deletionProtection: env.deletionProtection,
        removalPolicy,
        instanceIdentifier: `${env.name}-esri-geodatabase-replica`,
      });
    }

    // --- S3 buckets : LLD 7.2.2 / 7.3.4 ---
    const account = this.account;
    const region = this.region;

    this.objectStoreBucket = new s3.Bucket(this, 'ObjectStore', {
      bucketName: bucketName(env.name, 'object-store', account, region),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
    });

    this.imageStoreBucket = new s3.Bucket(this, 'ImageStore', {
      bucketName: bucketName(env.name, 'image-store', account, region),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
    });

    this.dataStoreBackupBucket = new s3.Bucket(this, 'DataStoreBackup', {
      bucketName: bucketName(env.name, 'datastore-backup', account, region),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          // 7.3.4: noncurrent versions -> Glacier IR after 90 days, expire after 7 years.
          noncurrentVersionTransitions: [
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(90) },
          ],
          noncurrentVersionExpiration: Duration.days(365 * 7),
        },
      ],
      removalPolicy,
    });

    // Load balancer access logs (ALB delivery requires SSE-S3, not SSE-KMS/CMK).
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogs', {
      bucketName: bucketName(env.name, 'access-logs', account, region),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(365 * 7) }],
      removalPolicy,
    });

    // --- FSx for Windows (config stores + File Data Store) : LLD 7.2.2 ---
    // Single-AZ, SMB. Requires AD; only deployed when env.activeDirectory is set.
    if (env.deployFsx) {
      if (!env.activeDirectory) {
        throw new Error(`deployFsx is true for ${env.name} but no activeDirectory config was provided`);
      }
      const fsxSg = new ec2.SecurityGroup(this, 'FsxSg', {
        vpc: v.vpc,
        securityGroupName: `${env.name}-sg-fsx`,
        description: 'FSx for Windows ENIs - SMB from VPC workloads',
        allowAllOutbound: true,
      });
      fsxSg.addIngressRule(ec2.Peer.ipv4('10.0.0.0/8'), ec2.Port.tcp(445), 'SMB from VPC workloads');

      const ad = env.activeDirectory;
      const fsxSubnetId = v.subnet('isolated-data-az-a').subnetId;

      const drives: Array<{ id: string; name: string; capacity: number }> = [
        { id: 'Drive1', name: 'config-stores', capacity: 100 },
        { id: 'Drive2', name: 'file-data-store', capacity: 200 },
      ];
      for (const d of drives) {
        new fsx.CfnFileSystem(this, `Fsx${d.id}`, {
          fileSystemType: 'WINDOWS',
          subnetIds: [fsxSubnetId],
          securityGroupIds: [fsxSg.securityGroupId],
          storageCapacity: d.capacity,
          storageType: 'SSD',
          kmsKeyId: props.kmsKey.keyArn,
          windowsConfiguration: {
            throughputCapacity: 32,
            deploymentType: 'SINGLE_AZ_2',
            automaticBackupRetentionDays: 7, // 7.3.3
            selfManagedActiveDirectoryConfiguration: {
              dnsIps: ad.dnsIps,
              domainName: ad.domainName,
              userName: 'fsxadmin',
              password: 'REPLACE_VIA_SECRET', // sourced from Secrets Manager at deploy time
              fileSystemAdministratorsGroup: ad.fileSystemAdministratorsGroup,
              organizationalUnitDistinguishedName: ad.organizationalUnitDistinguishedName,
            },
          },
          tags: [{ key: 'Name', value: `${env.name}-esri-fsx-${d.name}` }],
        });
      }
    }

    Tags.of(this).add('Environment', env.name);
    Tags.of(this).add('Workload', 'arcgis-enterprise');
    Tags.of(this).add('Component', 'data');
  }
}
