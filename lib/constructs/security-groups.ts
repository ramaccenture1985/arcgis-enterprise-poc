import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Ports, PortRanges } from '../config/ports';

/**
 * SecurityGroups encodes the complete LLD "Security group matrix"
 * (section 5.5, Tables 8-24) for the ArcGIS Enterprise deployment.
 *
 * All security groups are created with allowAllOutbound = false so every egress
 * path is explicit and least-privilege, matching the matrix.
 *
 * A few rules are added beyond the literal per-table listing where the LLD's
 * own component design (section 4.2) requires them for the deployment to
 * function - these are commented inline (e.g. Portal -> Internal ALB federation,
 * ArcGIS Server -> RDS). Placeholder groups sg-app and sg-fme are created for
 * the out-of-scope serverless/FME integration that the matrix references.
 */
export interface SecurityGroupsProps {
  readonly vpc: ec2.IVpc;
  readonly envName: string;
  /** AWS Client VPN client CIDR allowed to RDP to the Bastion (LLD 4.1.3). */
  readonly clientVpnCidr?: string;
}

const VPC_INTERNAL = '10.0.0.0/8';

export class SecurityGroups extends Construct {
  public readonly groups: Record<string, ec2.SecurityGroup> = {};
  private readonly clientVpnCidr: string;

  constructor(scope: Construct, id: string, props: SecurityGroupsProps) {
    super(scope, id);
    this.clientVpnCidr = props.clientVpnCidr ?? '10.100.0.0/16';

    const names = [
      'sg-alb-public', 'sg-portal-webadaptor', 'sg-portal', 'sg-nlb', 'sg-alb-internal',
      'sg-ags-webadaptor', 'sg-ags', 'sg-image-webadaptor', 'sg-image', 'sg-notebook',
      'sg-bastion', 'sg-monitor', 'sg-datastore', 'sg-rds', 'sg-rds-replica',
      'sg-cs-portal', 'sg-cs-ags', 'sg-cs-image',
      // Placeholders for out-of-scope integrations referenced by the matrix:
      'sg-app', 'sg-fme',
      // Connectivity-test Lambda (see ConnectivityTestStack).
      'sg-conntest',
    ];
    for (const n of names) {
      this.groups[n] = new ec2.SecurityGroup(this, n, {
        vpc: props.vpc,
        securityGroupName: `${props.envName}-${n}`,
        description: `${n} - ${props.envName} ArcGIS Enterprise`,
        allowAllOutbound: false,
        // These groups reference each other extensively (e.g. Portal <-> Internal
        // ALB). Inline rules would create CloudFormation circular dependencies
        // between the SG resources, so emit every rule as a standalone
        // SecurityGroupIngress/Egress resource instead.
        disableInlineRules: true,
      });
    }

    this.wireRules();
  }

  public sg(name: string): ec2.SecurityGroup {
    const g = this.groups[name];
    if (!g) throw new Error(`Security group "${name}" not defined`);
    return g;
  }

  // ---------------------------------------------------------------------------

  private wireRules(): void {
    const g = this.groups;
    const tcp = ec2.Port.tcp.bind(ec2.Port);
    const range = (r: { from: number; to: number }) => ec2.Port.tcpRange(r.from, r.to);
    const from = (peer: ec2.SecurityGroup) => ec2.Peer.securityGroupId(peer.securityGroupId);

    // --- sg-alb-public (External ALB) : Table 9 ---
    g['sg-alb-public'].addIngressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'HTTPS from internet (post-WAF)');
    g['sg-alb-public'].addIngressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'Health check return');
    g['sg-alb-public'].addEgressRule(from(g['sg-portal-webadaptor']), tcp(Ports.HTTPS), 'Forward to Portal Web Adaptor');
    g['sg-alb-public'].addEgressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'Health checks to targets');

    // --- sg-portal-webadaptor (Portal Web Adaptor, both AZs) : Table 10 ---
    g['sg-portal-webadaptor'].addIngressRule(from(g['sg-alb-public']), tcp(Ports.HTTPS), 'From External ALB');
    g['sg-portal-webadaptor'].addIngressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'ALB health checks');
    g['sg-portal-webadaptor'].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
    g['sg-portal-webadaptor'].addEgressRule(from(g['sg-portal']), tcp(Ports.PORTAL), 'Forward to Portal');
    g['sg-portal-webadaptor'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'Outbound via NAT');

    // --- sg-portal (Portal Primary/Secondary) : Table 11 ---
    g['sg-portal'].addIngressRule(from(g['sg-portal-webadaptor']), tcp(Ports.PORTAL), 'From Portal Web Adaptor');
    g['sg-portal'].addIngressRule(from(g['sg-portal']), range(PortRanges.PORTAL_HA), 'HA sync between Portal nodes');
    g['sg-portal'].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
    g['sg-portal'].addIngressRule(from(g['sg-monitor']), tcp(Ports.HTTPS), 'Monitor health checks');
    g['sg-portal'].addEgressRule(from(g['sg-alb-internal']), tcp(Ports.HTTPS), 'Federation to internal ALB');
    g['sg-portal'].addEgressRule(from(g['sg-notebook']), tcp(Ports.NOTEBOOK_SSR), 'Portal -> Notebook SSR');
    g['sg-portal'].addEgressRule(from(g['sg-cs-portal']), tcp(Ports.SMB), 'Config store SMB');
    g['sg-portal'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'NAT egress (Esri licensing etc)');
    g['sg-portal'].addEgressRule(from(g['sg-portal']), tcp(Ports.PORTAL), 'HA sync outbound');

    // --- sg-nlb (Private NLB) : Table 12 ---
    g['sg-nlb'].addIngressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'From API Gateway VPC Link');
    g['sg-nlb'].addEgressRule(from(g['sg-ags-webadaptor']), tcp(Ports.HTTPS), 'Forward to ArcGIS Server Web Adaptor');
    g['sg-nlb'].addEgressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'Health checks to Web Adaptor');

    // --- sg-alb-internal (Internal ALB) : Table 13 ---
    g['sg-alb-internal'].addIngressRule(from(g['sg-app']), tcp(Ports.HTTPS), 'Federation from serverless compute application');
    // Component design 4.2.1: Portal federates to ArcGIS Server via Internal ALB.
    g['sg-alb-internal'].addIngressRule(from(g['sg-portal']), tcp(Ports.HTTPS), 'Portal federation path');
    g['sg-alb-internal'].addEgressRule(from(g['sg-ags-webadaptor']), tcp(Ports.HTTPS), 'Forward to ArcGIS Server Web Adaptor');
    g['sg-alb-internal'].addEgressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'Health checks to targets');
    // Internal ALB also fronts Image Server Web Adaptor (4.2.3 / 4.2.4).
    g['sg-alb-internal'].addEgressRule(from(g['sg-image-webadaptor']), tcp(Ports.HTTPS), 'Forward to Image Server Web Adaptor');

    // --- sg-ags-webadaptor (ArcGIS Server Web Adaptor, both AZs) : Table 14 ---
    g['sg-ags-webadaptor'].addIngressRule(from(g['sg-nlb']), tcp(Ports.HTTPS), 'From NLB (API path)');
    g['sg-ags-webadaptor'].addIngressRule(from(g['sg-alb-internal']), tcp(Ports.HTTPS), 'From Internal ALB (Portal federation path)');
    g['sg-ags-webadaptor'].addIngressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'Health checks from NLB and ALB subnets');
    g['sg-ags-webadaptor'].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
    g['sg-ags-webadaptor'].addEgressRule(from(g['sg-ags']), tcp(Ports.SERVER), 'Forward to ArcGIS Server Site');
    g['sg-ags-webadaptor'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'NAT egress');

    // --- sg-ags (ArcGIS Server, both AZs) : Table 15 ---
    g['sg-ags'].addIngressRule(from(g['sg-ags-webadaptor']), tcp(Ports.SERVER), 'From ArcGIS Server Web Adaptor');
    g['sg-ags'].addIngressRule(from(g['sg-ags']), range(PortRanges.SERVER_REPLICATION), 'ArcGIS Server inter-node site replication');
    g['sg-ags'].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
    g['sg-ags'].addIngressRule(from(g['sg-monitor']), tcp(Ports.HTTPS), 'Monitor health checks');
    g['sg-ags'].addIngressRule(from(g['sg-fme']), tcp(Ports.SERVER), 'Allow FME to access');
    g['sg-ags'].addEgressRule(from(g['sg-portal']), tcp(Ports.PORTAL), 'Federation back to Portal');
    g['sg-ags'].addEgressRule(from(g['sg-datastore']), tcp(Ports.DATASTORE_RELATIONAL), 'To Data Store');
    g['sg-ags'].addEgressRule(from(g['sg-cs-ags']), tcp(Ports.SMB), 'Config store SMB');
    g['sg-ags'].addEgressRule(from(g['sg-ags']), range(PortRanges.SERVER_REPLICATION), 'Inter-node replication outbound');
    g['sg-ags'].addEgressRule(from(g['sg-rds']), tcp(Ports.POSTGRES), 'To RDS PostgreSQL (Enterprise Geodatabase)');
    g['sg-ags'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'NAT egress');

    // --- sg-image-webadaptor (Image Server Web Adaptor, both AZs) : Table 16 ---
    g['sg-image-webadaptor'].addIngressRule(from(g['sg-alb-internal']), tcp(Ports.HTTPS), 'From Internal ALB');
    g['sg-image-webadaptor'].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
    g['sg-image-webadaptor'].addEgressRule(from(g['sg-image']), tcp(Ports.SERVER), 'Forward to Image Server Site');
    g['sg-image-webadaptor'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'NAT egress');

    // --- sg-image (Image Server, both AZs) : Table 17 ---
    g['sg-image'].addIngressRule(from(g['sg-image-webadaptor']), tcp(Ports.SERVER), 'From Image Server Web Adaptor');
    g['sg-image'].addIngressRule(from(g['sg-image']), range(PortRanges.IMAGE_REPLICATION), 'Inter-node replication');
    g['sg-image'].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
    g['sg-image'].addIngressRule(from(g['sg-monitor']), tcp(Ports.HTTPS), 'Monitor health checks');
    g['sg-image'].addEgressRule(from(g['sg-portal']), tcp(Ports.PORTAL), 'Federation back to Portal');
    g['sg-image'].addEgressRule(from(g['sg-cs-image']), tcp(Ports.SMB), 'Config store SMB');
    g['sg-image'].addEgressRule(from(g['sg-image']), range(PortRanges.IMAGE_REPLICATION), 'Inter-node outbound');
    g['sg-image'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'NAT egress');

    // --- sg-notebook (Notebook Server) : Table 18 ---
    g['sg-notebook'].addIngressRule(from(g['sg-portal']), tcp(Ports.NOTEBOOK_SSR), 'From Portal SSR only');
    g['sg-notebook'].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
    g['sg-notebook'].addEgressRule(from(g['sg-portal']), tcp(Ports.PORTAL), 'Federation back to Portal');
    g['sg-notebook'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'NAT egress (notebook kernels)');

    // --- sg-bastion (Bastion host) : Table 19 ---
    g['sg-bastion'].addIngressRule(ec2.Peer.ipv4(this.clientVpnCidr), tcp(Ports.RDP), 'RDP from AWS VPN only');
    for (const target of [
      'sg-portal-webadaptor', 'sg-portal', 'sg-ags-webadaptor', 'sg-ags',
      'sg-image-webadaptor', 'sg-image', 'sg-notebook',
      'sg-cs-portal', 'sg-cs-ags', 'sg-cs-image', 'sg-monitor',
    ]) {
      g['sg-bastion'].addEgressRule(from(g[target]), tcp(Ports.RDP), `RDP to ${target}`);
    }
    // HTTPS to the VPC interface endpoints so the Bastion is itself SSM-managed
    // (Session Manager / Fleet Manager) - internal to the VPC, no internet egress.
    g['sg-bastion'].addEgressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'HTTPS to VPC interface endpoints (SSM, CloudWatch)');

    // --- sg-monitor (ArcGIS Monitor) : Table 20 ---
    g['sg-monitor'].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
    for (const target of [
      'sg-portal-webadaptor', 'sg-portal', 'sg-ags-webadaptor', 'sg-ags',
      'sg-image-webadaptor', 'sg-image', 'sg-notebook',
    ]) {
      g['sg-monitor'].addEgressRule(from(g[target]), tcp(Ports.HTTPS), `Poll ${target} health`);
    }
    g['sg-monitor'].addEgressRule(from(g['sg-ags']), ec2.Port.udp(Ports.SQL_BROWSER), 'SQL Server browser (if used)');
    g['sg-monitor'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'NAT egress (Monitor updates)');

    // --- sg-datastore (Data Store Primary/Standby) : Table 21 ---
    g['sg-datastore'].addIngressRule(from(g['sg-ags']), tcp(Ports.DATASTORE_RELATIONAL), 'From ArcGIS Server');
    g['sg-datastore'].addIngressRule(from(g['sg-datastore']), ec2.Port.tcp(9820), 'Inter-node replication');
    g['sg-datastore'].addIngressRule(from(g['sg-datastore']), ec2.Port.tcp(9850), 'Inter-node replication');
    g['sg-datastore'].addIngressRule(from(g['sg-datastore']), ec2.Port.tcp(9840), 'Tile cache inter-node');
    g['sg-datastore'].addIngressRule(from(g['sg-datastore']), ec2.Port.tcp(PortRanges.DATASTORE_WEBHOOKS.from), 'Webhooks');
    g['sg-datastore'].addIngressRule(from(g['sg-datastore']), ec2.Port.tcp(PortRanges.DATASTORE_WEBHOOKS.to), 'Webhooks');
    g['sg-datastore'].addEgressRule(from(g['sg-rds']), tcp(Ports.POSTGRES), 'To RDS PostgreSQL');
    g['sg-datastore'].addEgressRule(from(g['sg-datastore']), ec2.Port.tcp(9820), 'Replication outbound');
    g['sg-datastore'].addEgressRule(from(g['sg-datastore']), ec2.Port.tcp(9850), 'Replication outbound');
    g['sg-datastore'].addEgressRule(from(g['sg-datastore']), ec2.Port.tcp(9840), 'Tile cache outbound');
    // HTTPS to the VPC interface endpoints (SSM Session Manager/Run Command,
    // CloudWatch, KMS) - kept internal to the VPC, no internet egress.
    g['sg-datastore'].addEgressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.HTTPS), 'HTTPS to VPC interface endpoints (SSM, CloudWatch, KMS)');

    // --- sg-rds (RDS PostgreSQL Primary/Standby) : Table 22 ---
    g['sg-rds'].addIngressRule(from(g['sg-datastore']), tcp(Ports.POSTGRES), 'From Data Store');
    // Component design 4.2.2: ArcGIS Server reaches the Enterprise Geodatabase.
    g['sg-rds'].addIngressRule(from(g['sg-ags']), tcp(Ports.POSTGRES), 'From ArcGIS Server (Enterprise Geodatabase)');
    g['sg-rds'].addEgressRule(from(g['sg-rds']), tcp(Ports.POSTGRES), 'RDS inter-node (managed by AWS)');

    // --- sg-rds-replica (RDS Read Replica) : Table 23 ---
    g['sg-rds-replica'].addIngressRule(from(g['sg-datastore']), tcp(Ports.POSTGRES), 'Read queries from Data Store');
    g['sg-rds-replica'].addEgressRule(from(g['sg-rds']), tcp(Ports.POSTGRES), 'Replication from RDS primary (managed by AWS)');

    // --- sg-cs-portal / sg-cs-ags / sg-cs-image (Config Stores) : Table 24 ---
    const configStores: Array<[string, string]> = [
      ['sg-cs-portal', 'sg-portal'],
      ['sg-cs-ags', 'sg-ags'],
      ['sg-cs-image', 'sg-image'],
    ];
    for (const [cs, source] of configStores) {
      g[cs].addIngressRule(from(g[source]), tcp(Ports.SMB), 'SMB config store reads');
      g[cs].addIngressRule(from(g['sg-bastion']), tcp(Ports.RDP), 'RDP admin');
      g[cs].addEgressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(Ports.SMB), 'SMB response');
      g[cs].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'NAT egress if needed');
    }

    // --- sg-conntest (connectivity-test Lambda) ---
    // Egress: the component/LB/endpoint ports the test probes, internal-only,
    // plus HTTPS to the internet (S3 gateway + interface-endpoint validation).
    const conntestEgressPorts = [Ports.HTTPS, Ports.POSTGRES, Ports.DATASTORE_RELATIONAL, Ports.SERVER, Ports.PORTAL, Ports.SMB];
    for (const p of conntestEgressPorts) {
      g['sg-conntest'].addEgressRule(ec2.Peer.ipv4(VPC_INTERNAL), tcp(p), `Connectivity test to ${p}`);
    }
    g['sg-conntest'].addEgressRule(ec2.Peer.anyIpv4(), tcp(Ports.HTTPS), 'HTTPS to S3 / AWS endpoints');

    // Ingress on the probe targets so the test connections are accepted. These
    // are clearly test-only allowances from the connectivity-test SG.
    g['sg-alb-public'].addIngressRule(from(g['sg-conntest']), tcp(Ports.HTTPS), 'Connectivity test');
    g['sg-alb-internal'].addIngressRule(from(g['sg-conntest']), tcp(Ports.HTTPS), 'Connectivity test');
    g['sg-nlb'].addIngressRule(from(g['sg-conntest']), tcp(Ports.HTTPS), 'Connectivity test');
    g['sg-rds'].addIngressRule(from(g['sg-conntest']), tcp(Ports.POSTGRES), 'Connectivity test');
    g['sg-rds-replica'].addIngressRule(from(g['sg-conntest']), tcp(Ports.POSTGRES), 'Connectivity test');
    g['sg-datastore'].addIngressRule(from(g['sg-conntest']), tcp(Ports.DATASTORE_RELATIONAL), 'Connectivity test');
    g['sg-ags'].addIngressRule(from(g['sg-conntest']), tcp(Ports.SERVER), 'Connectivity test');
    g['sg-portal'].addIngressRule(from(g['sg-conntest']), tcp(Ports.PORTAL), 'Connectivity test');
  }
}
