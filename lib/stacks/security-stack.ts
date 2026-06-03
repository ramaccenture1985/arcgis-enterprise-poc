import { Stack, StackProps, Tags, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { EnvironmentConfig } from '../config/environments';
import { bucketArns } from '../config/naming';

export interface SecurityStackProps extends StackProps {
  readonly envConfig: EnvironmentConfig;
}

/**
 * SecurityStack provisions the per-environment cryptographic and identity
 * controls (LLD section 9):
 *   - a customer-managed KMS key (encryption at rest, separate key per env - 9.5)
 *   - IAM roles for each workload (Table 45, least-privilege - 9.1.3)
 *   - Secrets Manager secrets for ArcGIS administrative credentials (9.2)
 *
 * IAM S3 permissions are scoped to deterministic bucket ARNs (see config/naming)
 * so this stack does not depend on the DataStack that creates the buckets.
 */
export class SecurityStack extends Stack {
  public readonly kmsKey: kms.Key;
  public readonly roles: Record<string, iam.IRole> = {};
  public readonly siteAdminSecret: secretsmanager.Secret;
  public readonly portalAdminSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);
    const env = props.envConfig;
    const account = this.account;
    const region = this.region;

    // --- KMS customer-managed key (per environment) ---
    this.kmsKey = new kms.Key(this, 'EsriKmsKey', {
      alias: `alias/${env.name}-esri`,
      description: `${env.name} ArcGIS Enterprise CMK (EBS, RDS, FSx, S3, Secrets)`,
      enableKeyRotation: true,
      removalPolicy: env.productionGrade ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    // Allow AWS services that integrate via grants (RDS, FSx, EBS, Logs) to use the key.
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowServiceUseViaGrants',
      principals: [
        new iam.ServicePrincipal('rds.amazonaws.com'),
        new iam.ServicePrincipal('fsx.amazonaws.com'),
        new iam.ServicePrincipal('logs.amazonaws.com'),
        new iam.ServicePrincipal('backup.amazonaws.com'),
        new iam.ServicePrincipal('ec2.amazonaws.com'), // EBS root-volume CMK encryption
      ],
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:CreateGrant', 'kms:DescribeKey'],
      resources: ['*'],
    }));

    const objectStore = bucketArns(env.name, 'object-store', account, region);
    const imageStore = bucketArns(env.name, 'image-store', account, region);
    const dsBackup = bucketArns(env.name, 'datastore-backup', account, region);

    const kmsDataKeyActions = ['kms:GenerateDataKey', 'kms:Decrypt'];

    // --- role-arcgis-portal : Portal content directory + backup bucket access ---
    this.roles['role-arcgis-portal'] = this.ec2Role('role-arcgis-portal', env, [
      new iam.PolicyStatement({
        sid: 'PortalContentAndBackup',
        actions: [
          's3:Get*', 's3:PutObject', 's3:ListBucket', 's3:CreateBucket', 's3:DeleteObject',
          's3:GetBucketAcl', 's3:PutObjectAcl',
        ],
        resources: [objectStore.bucket, objectStore.objects, dsBackup.bucket, dsBackup.objects],
      }),
      new iam.PolicyStatement({ actions: kmsDataKeyActions, resources: [this.kmsKey.keyArn] }),
      new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [`arn:aws:secretsmanager:${region}:${account}:secret:${env.name}/esri/*`] }),
    ]);

    // --- role-arcgis-server : Object Store + Data Store backup S3 access ---
    this.roles['role-arcgis-server'] = this.ec2Role('role-arcgis-server', env, [
      new iam.PolicyStatement({
        sid: 'ObjectStoreFull',
        actions: [
          's3:ListBucket', 's3:ListMultipartUploadParts', 's3:GetBucketAcl', 's3:GetBucketLocation',
          's3:GetBucketPolicy', 's3:GetObject', 's3:GetLifecycleConfiguration', 's3:DeleteObjectTagging',
          's3:PutBucketTagging', 's3:PutObjectTagging', 's3:CreateBucket', 's3:DeleteBucket',
          's3:DeleteObject', 's3:PutObject', 's3:PutLifecycleConfiguration', 's3:GetObjectVersion',
        ],
        resources: [objectStore.bucket, objectStore.objects],
      }),
      new iam.PolicyStatement({
        sid: 'DataStoreBackup',
        actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket', 's3:DeleteObject', 's3:GetBucketAcl', 's3:PutObjectAcl'],
        resources: [dsBackup.bucket, dsBackup.objects],
      }),
      new iam.PolicyStatement({ actions: kmsDataKeyActions, resources: [this.kmsKey.keyArn] }),
    ]);

    // --- role-arcgis-image : Image Server registered cloud store access ---
    this.roles['role-arcgis-image'] = this.ec2Role('role-arcgis-image', env, [
      new iam.PolicyStatement({
        sid: 'ImageStore',
        actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket', 's3:GetBucketAcl', 's3:GetObjectVersion'],
        resources: [imageStore.bucket, imageStore.objects],
      }),
      new iam.PolicyStatement({ actions: kmsDataKeyActions, resources: [this.kmsKey.keyArn] }),
    ]);

    // --- role-arcgis-notebook : Notebook output S3 access ---
    this.roles['role-arcgis-notebook'] = this.ec2Role('role-arcgis-notebook', env, [
      new iam.PolicyStatement({
        sid: 'NotebookOutput',
        actions: [
          's3:PutObject', 's3:GetObject', 's3:ListBucket', 's3:ListMultipartUploadParts',
          's3:GetBucketAcl', 's3:GetObjectVersion', 's3:GetLifecycleConfiguration', 's3:DeleteObject',
        ],
        resources: [objectStore.bucket, objectStore.objects],
      }),
      new iam.PolicyStatement({ actions: kmsDataKeyActions, resources: [this.kmsKey.keyArn] }),
    ]);

    // --- role-arcgis-ec2-base : Web Adaptors, Bastion, Monitor, Data Store ---
    // No extra inline statements needed beyond the common SSM + CloudWatch agent
    // policies that ec2Role() attaches to every instance role.
    this.roles['role-arcgis-ec2-base'] = this.ec2Role('role-arcgis-ec2-base', env, []);

    // --- role-arcgis-backup : AWS Backup service role ---
    const backupRole = new iam.Role(this, 'RoleArcgisBackup', {
      roleName: `${env.name}-role-arcgis-backup`,
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'),
      ],
    });
    this.roles['role-arcgis-backup'] = backupRole;

    // --- role-arcgis-monitor-aws-user : ArcGIS Monitor Agent (read-only) ---
    // Table 45 specifies an IAM user + access key pair. The user and policies
    // are created here; access keys are issued out-of-band and stored in
    // Secrets Manager (avoids embedding long-lived credentials in the template).
    const monitorUser = new iam.User(this, 'UserArcgisMonitor', {
      userName: `${env.name}-arcgis-monitor-aws-user`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ReadOnlyAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRDSReadOnlyAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchReadOnlyAccess'),
      ],
    });
    this.roles['user-arcgis-monitor'] = monitorUser as unknown as iam.IRole;

    // --- Secrets Manager secrets (encrypted with the CMK, LLD 9.2) ---
    this.siteAdminSecret = new secretsmanager.Secret(this, 'SiteAdminSecret', {
      secretName: `${env.name}/esri/primary-site-administrator`,
      description: 'ArcGIS Enterprise primary site administrator credentials',
      encryptionKey: this.kmsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'siteadmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 24,
      },
    });

    this.portalAdminSecret = new secretsmanager.Secret(this, 'PortalAdminSecret', {
      secretName: `${env.name}/esri/portal-administrator`,
      description: 'Portal for ArcGIS initial administrator credentials',
      encryptionKey: this.kmsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'portaladmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 24,
      },
    });

    Tags.of(this).add('Environment', env.name);
    Tags.of(this).add('Workload', 'arcgis-enterprise');
    Tags.of(this).add('Component', 'security');
  }

  /**
   * Helper: an EC2 service-assumed role with inline statements, plus the common
   * managed policies attached to EVERY ArcGIS instance role:
   *   - AmazonSSMManagedInstanceCore: enables AWS Systems Manager (Session
   *     Manager, Fleet Manager Remote Desktop, Run Command) on the instance,
   *     so an operator (e.g. an Esri engineer) can remote in to run installers
   *     without any inbound port exposure. Relies on the ssm/ssmmessages/
   *     ec2messages interface VPC endpoints provisioned in the NetworkStack.
   *   - CloudWatchAgentServerPolicy: lets the CloudWatch agent publish metrics
   *     and logs.
   */
  private ec2Role(name: string, env: EnvironmentConfig, statements: iam.PolicyStatement[]): iam.Role {
    const role = new iam.Role(this, this.pascal(name), {
      roleName: `${env.name}-${name}`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `${name} (${env.name})`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    statements.forEach((s) => role.addToPolicy(s));

    // Read-only access to a shared "installers/" prefix in the object-store
    // bucket, so an operator can stage ArcGIS setups in S3 and pull them onto
    // any instance (alternative to copying over RDP).
    const objectStore = bucketArns(env.name, 'object-store', this.account, this.region);
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'InstallerStagingRead',
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [`${objectStore.bucket}/installers/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'InstallerStagingList',
      actions: ['s3:ListBucket'],
      resources: [objectStore.bucket],
      conditions: { StringLike: { 's3:prefix': ['installers/*'] } },
    }));
    return role;
  }

  private pascal(kebab: string): string {
    return kebab.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  }
}
