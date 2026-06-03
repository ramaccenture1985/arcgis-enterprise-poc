import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { EnvironmentConfig } from '../config/environments';
import { EsriVpc } from '../constructs/esri-vpc';
import { SecurityGroups } from '../constructs/security-groups';

export interface NetworkStackProps extends StackProps {
  readonly envConfig: EnvironmentConfig;
}

/**
 * NetworkStack provisions the foundational network for one environment:
 *   - the ArcGIS Enterprise VPC (subnets, routing, NACLs, optional firewall)
 *   - the full security-group matrix
 *   - VPC endpoints (LLD Table 26: S3 gateway + interface endpoints)
 *   - the Route 53 private hosted zone (LLD 5.8)
 *
 * Downstream stacks (Security, Data, LoadBalancer, Compute) consume the VPC,
 * subnets, security groups and hosted zone exposed here.
 */
export class NetworkStack extends Stack {
  public readonly esriVpc: EsriVpc;
  public readonly securityGroups: SecurityGroups;
  public readonly privateHostedZone: route53.PrivateHostedZone;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const env = props.envConfig;

    this.esriVpc = new EsriVpc(this, 'EsriVpc', { env });
    this.securityGroups = new SecurityGroups(this, 'SecurityGroups', {
      vpc: this.esriVpc.vpc,
      envName: env.name,
    });

    this.createVpcEndpoints(env);

    this.privateHostedZone = new route53.PrivateHostedZone(this, 'PrivateHostedZone', {
      zoneName: env.internalDomain,
      vpc: this.esriVpc.vpc,
      comment: `Internal DNS for ${env.name} ArcGIS Enterprise (LLD 5.8)`,
    });

    Tags.of(this).add('Environment', env.name);
    Tags.of(this).add('Workload', 'arcgis-enterprise');
    Tags.of(this).add('Component', 'network');
  }

  /**
   * VPC endpoints per LLD Table 26.
   *   - S3: Gateway endpoint, associated with the private/isolated route tables.
   *   - SSM, SSM Messages, EC2 Messages, Secrets Manager, CloudWatch Logs, KMS:
   *     Interface endpoints in the private workload subnets.
   */
  private createVpcEndpoints(env: EnvironmentConfig): void {
    const v = this.esriVpc;

    // Route tables that should reach S3 privately (Table 27 consumers).
    const s3RouteTableKeys = [
      'private-bastion-az-a',
      'private-portal-az-a', 'private-portal-az-b',
      'private-services-az-a', 'private-services-az-b',
      'private-monitoring-az-a',
      'isolated-data-az-a', 'isolated-data-az-b',
    ];
    const s3RouteTableIds = s3RouteTableKeys.map(
      (k) => v.subnet(k).routeTable.routeTableId,
    );

    new ec2.CfnVPCEndpoint(this, 'VpceS3', {
      vpcId: v.vpcId,
      serviceName: `com.amazonaws.${env.region}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: s3RouteTableIds,
    });

    // Interface endpoints share a dedicated security group (HTTPS from VPC).
    const endpointSg = new ec2.SecurityGroup(this, 'VpceInterfaceSg', {
      vpc: v.vpc,
      securityGroupName: `${env.name}-sg-vpce-interface`,
      description: 'Interface VPC endpoint ENIs - HTTPS from within the VPC',
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(ec2.Peer.ipv4('10.0.0.0/8'), ec2.Port.tcp(443), 'HTTPS from VPC workloads');

    // Interface endpoints placed in the private workload subnets (Table 26).
    const interfaceSubnetKeys = [
      'private-portal-az-a', 'private-portal-az-b',
      'private-services-az-a', 'private-services-az-b',
      'private-monitoring-az-a',
    ];
    const interfaceSubnetIds = interfaceSubnetKeys.map((k) => v.subnet(k).subnetId);

    const interfaceServices: Record<string, string> = {
      Ssm: `com.amazonaws.${env.region}.ssm`,
      SsmMessages: `com.amazonaws.${env.region}.ssmmessages`,
      Ec2Messages: `com.amazonaws.${env.region}.ec2messages`,
      SecretsManager: `com.amazonaws.${env.region}.secretsmanager`,
      Logs: `com.amazonaws.${env.region}.logs`,
      Kms: `com.amazonaws.${env.region}.kms`,
    };

    for (const [name, serviceName] of Object.entries(interfaceServices)) {
      new ec2.CfnVPCEndpoint(this, `Vpce${name}`, {
        vpcId: v.vpcId,
        serviceName,
        vpcEndpointType: 'Interface',
        subnetIds: interfaceSubnetIds,
        securityGroupIds: [endpointSg.securityGroupId],
        privateDnsEnabled: true,
      });
    }
  }
}
