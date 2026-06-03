import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { EnvironmentConfig } from '../config/environments';
import { EsriVpc } from '../constructs/esri-vpc';
import { SecurityGroups } from '../constructs/security-groups';
import { ArcgisInstance } from '../constructs/arcgis-instance';

export interface ComputeStackProps extends StackProps {
  readonly envConfig: EnvironmentConfig;
  readonly esriVpc: EsriVpc;
  readonly securityGroups: SecurityGroups;
  readonly roles: Record<string, iam.IRole>;
  /** Per-environment CMK used for EC2 root-volume encryption. */
  readonly kmsKey: kms.IKey;
}

/**
 * ComputeStack provisions every ArcGIS Enterprise EC2 instance (LLD section 4.2
 * and the Table 30 sizing), placing each in its designated subnet with the
 * correct security group and IAM role, and registering the Web Adaptors to the
 * appropriate load-balancer target groups.
 *
 * Topology (per the LLD per-component design):
 *   - Portal + Portal Web Adaptor       -> private-portal-az-a / az-b
 *   - ArcGIS Server + WA, Image + WA,
 *     Notebook, Config Stores           -> private-services-az-a / az-b
 *   - Data Store primary / standby       -> isolated-data-az-a / az-b
 *   - ArcGIS Monitor                     -> private-monitoring-az-a
 *   - Bastion                            -> private-bastion-az-a
 */
export class ComputeStack extends Stack {
  /** Portal Web Adaptor instances (registered to the Public ALB target group). */
  public readonly portalWebAdaptors: ec2.Instance[];
  /** ArcGIS Server Web Adaptor instances (Internal ALB + Private NLB). */
  public readonly agsWebAdaptors: ec2.Instance[];
  /** Image Server Web Adaptor instances (Internal ALB image path). */
  public readonly imageWebAdaptors: ec2.Instance[];

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const env = props.envConfig;
    const v = props.esriVpc;
    const sg = props.securityGroups;
    const roles = props.roles;
    const c = env.compute;

    // One EC2 key pair per environment, shared by all instances. CDK stores the
    // private key material in SSM Parameter Store at
    // /ec2/keypair/<key-pair-id>; retrieve it to decrypt the Windows
    // Administrator password for RDP. (Day-to-day access is via SSM; the key
    // pair exists so an operator can obtain interactive Administrator creds.)
    const adminKeyPair = new ec2.KeyPair(this, 'AdminKeyPair', {
      keyPairName: `${env.name}-esri-admin`,
    });

    const mk = (
      id: string,
      subnetKey: string,
      sgName: string,
      roleKey: string,
      instanceType: ec2.InstanceType,
      rootGib?: number,
      preserveRootVolume?: boolean,
    ) =>
      new ArcgisInstance(this, id, {
        vpc: v.vpc,
        subnet: v.subnet(subnetKey),
        securityGroup: sg.sg(sgName),
        role: roles[roleKey],
        instanceType,
        keyPair: adminKeyPair,
        kmsKey: props.kmsKey,
        preserveRootVolume,
        nameTag: `${env.name}-esri-${id}`,
        rootVolumeGib: rootGib,
      }).instance;

    // --- Portal tier (private-portal subnets) ---
    const waPortalA = mk('wa-portal-az-a', 'private-portal-az-a', 'sg-portal-webadaptor', 'role-arcgis-ec2-base', c.webAdaptorPortal);
    const waPortalB = mk('wa-portal-az-b', 'private-portal-az-b', 'sg-portal-webadaptor', 'role-arcgis-ec2-base', c.webAdaptorPortal);
    mk('portal-primary', 'private-portal-az-a', 'sg-portal', 'role-arcgis-portal', c.portal, 150);
    mk('portal-secondary', 'private-portal-az-b', 'sg-portal', 'role-arcgis-portal', c.portal, 150);

    // --- ArcGIS Server tier (private-services subnets) ---
    const waAgsA = mk('wa-ags-az-a', 'private-services-az-a', 'sg-ags-webadaptor', 'role-arcgis-ec2-base', c.webAdaptorServer);
    const waAgsB = mk('wa-ags-az-b', 'private-services-az-b', 'sg-ags-webadaptor', 'role-arcgis-ec2-base', c.webAdaptorServer);
    mk('ags-hosting-az-a', 'private-services-az-a', 'sg-ags', 'role-arcgis-server', c.arcgisServer, 200);
    mk('ags-az-b', 'private-services-az-b', 'sg-ags', 'role-arcgis-server', c.arcgisServer, 200);

    // --- Image Server tier (private-services subnets) ---
    const waImageA = mk('wa-image-az-a', 'private-services-az-a', 'sg-image-webadaptor', 'role-arcgis-ec2-base', c.webAdaptorImage);
    const waImageB = mk('wa-image-az-b', 'private-services-az-b', 'sg-image-webadaptor', 'role-arcgis-ec2-base', c.webAdaptorImage);
    mk('image-az-a', 'private-services-az-a', 'sg-image', 'role-arcgis-image', c.imageServer, 200);
    mk('image-az-b', 'private-services-az-b', 'sg-image', 'role-arcgis-image', c.imageServer, 200);

    // --- Notebook Server (single, private-services-az-a) ---
    mk('notebook', 'private-services-az-a', 'sg-notebook', 'role-arcgis-notebook', c.notebookServer, 200);

    // --- Data Store (isolated-data, inverse primary/standby across AZs) ---
    // Relational Data Store data lives on the attached EBS, so preserve the root
    // volume on termination (LLD 7.1 / 7.3.1).
    mk('datastore-primary', 'isolated-data-az-a', 'sg-datastore', 'role-arcgis-ec2-base', c.dataStore, 200, true);
    mk('datastore-standby', 'isolated-data-az-b', 'sg-datastore', 'role-arcgis-ec2-base', c.dataStore, 200, true);

    // --- Config Stores (private-services-az-a) ---
    mk('config-store-portal', 'private-services-az-a', 'sg-cs-portal', 'role-arcgis-ec2-base', c.configStore);
    mk('config-store-ags', 'private-services-az-a', 'sg-cs-ags', 'role-arcgis-ec2-base', c.configStore);
    mk('config-store-image', 'private-services-az-a', 'sg-cs-image', 'role-arcgis-ec2-base', c.configStore);

    // --- ArcGIS Monitor (private-monitoring-az-a) ---
    mk('monitor', 'private-monitoring-az-a', 'sg-monitor', 'role-arcgis-ec2-base', c.monitor);

    // --- Bastion (private-bastion-az-a) ---
    mk('bastion', 'private-bastion-az-a', 'sg-bastion', 'role-arcgis-ec2-base', c.bastion);

    // Expose Web Adaptors so the LoadBalancerStack can register them to the
    // appropriate target groups (LLD section 8 entry points).
    this.portalWebAdaptors = [waPortalA, waPortalB];
    this.agsWebAdaptors = [waAgsA, waAgsB];
    this.imageWebAdaptors = [waImageA, waImageB];

    this.configureCloudWatchAgent(env);

    Tags.of(this).add('Environment', env.name);
    Tags.of(this).add('Workload', 'arcgis-enterprise');
    Tags.of(this).add('Component', 'compute');
  }

  /**
   * Configures and starts the CloudWatch agent on every instance in this
   * environment (LLD §10 AWS infrastructure monitoring). The agent ships on the
   * AWS Windows AMI; here we publish its configuration to SSM Parameter Store
   * and use the managed `AmazonCloudWatch-ManageAgent` document via an SSM
   * association (targeting instances by their Environment tag) to apply it and
   * restart the agent. Pairs with CloudWatchAgentServerPolicy on the roles.
   */
  private configureCloudWatchAgent(env: EnvironmentConfig): void {
    const logPrefix = `/${env.name}/arcgis/windows`;
    const agentConfig = {
      agent: { metrics_collection_interval: 60 },
      logs: {
        logs_collected: {
          windows_events: {
            collect_list: ['System', 'Application'].map((channel) => ({
              event_name: channel,
              event_levels: ['ERROR', 'WARNING', 'CRITICAL'],
              event_format: 'xml',
              log_group_name: `${logPrefix}/${channel.toLowerCase()}`,
              log_stream_name: '{instance_id}',
              retention_in_days: env.productionGrade ? 90 : 30,
            })),
          },
        },
      },
      metrics: {
        append_dimensions: { InstanceId: '${aws:InstanceId}' },
        aggregation_dimensions: [['InstanceId']],
        metrics_collected: {
          LogicalDisk: { measurement: ['% Free Space'], resources: ['*'] },
          Memory: { measurement: ['% Committed Bytes In Use'] },
          'Paging File': { measurement: ['% Usage'], resources: ['*'] },
          Processor: { measurement: ['% Processor Time'], resources: ['_Total'] },
        },
      },
    };

    const configParam = new ssm.StringParameter(this, 'CwAgentConfig', {
      parameterName: `/${env.name}/esri/cloudwatch-agent-config`,
      description: `CloudWatch agent config for ${env.name} ArcGIS Enterprise`,
      stringValue: JSON.stringify(agentConfig),
      tier: ssm.ParameterTier.STANDARD,
    });

    new ssm.CfnAssociation(this, 'CwAgentAssociation', {
      name: 'AmazonCloudWatch-ManageAgent',
      associationName: `${env.name}-esri-cloudwatch-agent`,
      targets: [{ key: 'tag:Environment', values: [env.name] }],
      parameters: {
        action: ['configure'],
        mode: ['ec2'],
        optionalConfigurationSource: ['ssm'],
        optionalConfigurationLocation: [configParam.parameterName],
        optionalRestart: ['yes'],
      },
      // Re-apply if the agent drifts.
      scheduleExpression: 'rate(30 days)',
    });
  }
}
