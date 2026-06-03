import { Construct } from 'constructs';
import { Fn, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as nf from 'aws-cdk-lib/aws-networkfirewall';
import { EnvironmentConfig } from '../config/environments';
import {
  SUBNET_PLAN,
  SubnetSpec,
  subnetCidr,
  SubnetExposure,
} from '../config/network-layout';

/**
 * EsriVpc builds the ArcGIS Enterprise VPC exactly as specified in the LLD
 * "Network design" (section 5): explicit subnets per Table 4, an Internet
 * Gateway, per-AZ NAT Gateways, tier-specific route tables (Table 5),
 * Network ACLs (Table 25) and - where enabled - AWS Network Firewall with
 * outbound inspection routing (section 5.4).
 *
 * Subnets are created as concrete `ec2.Subnet` objects so callers can place
 * resources in an exact subnet (e.g. private-portal-az-a). An IVpc view is also
 * exposed for L2 constructs that require one; placement is always done by
 * passing explicit subnets, so subnet-type grouping on the imported view is not
 * relied upon.
 */
export interface EsriVpcProps {
  readonly env: EnvironmentConfig;
}

export class EsriVpc extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly vpcId: string;
  public readonly subnets: Map<string, ec2.Subnet> = new Map();
  public readonly availabilityZones: [string, string];

  private readonly cfnVpc: ec2.CfnVPC;
  private readonly env: EnvironmentConfig;
  private readonly natGatewayIdByAz: string[] = [];

  constructor(scope: Construct, id: string, props: EsriVpcProps) {
    super(scope, id);
    this.env = props.env;
    this.availabilityZones = props.env.availabilityZones;

    this.cfnVpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: props.env.vpcCidr,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: [{ key: 'Name', value: `${props.env.name}-esri-vpc` }],
    });
    this.vpcId = this.cfnVpc.ref;

    const igw = new ec2.CfnInternetGateway(this, 'Igw', {
      tags: [{ key: 'Name', value: `${props.env.name}-esri-igw` }],
    });
    new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: this.vpcId,
      internetGatewayId: igw.ref,
    });

    // Create all subnets from the plan.
    for (const spec of SUBNET_PLAN) {
      this.createSubnet(spec);
    }

    // NAT Gateways: one per public-nat subnet (per-AZ egress, LLD 5.1.3).
    this.createNatGateways();

    // Optional AWS Network Firewall (LLD 5.4). Created before routing so the
    // outbound inspection routes can target the firewall endpoints.
    let firewallEndpointByAz: string[] | undefined;
    if (props.env.deployNetworkFirewall) {
      firewallEndpointByAz = this.createNetworkFirewall();
    }

    // Wire routing per tier (Table 5).
    this.configureRouting(igw, firewallEndpointByAz);

    // Network ACLs (Table 25).
    this.configureNacls();

    // IVpc view for L2 constructs. Subnet-type lists are intentionally left
    // empty: every resource in this codebase is placed with an explicit subnet
    // selection (vpcSubnets: { subnets: [...] }), so the imported view is only
    // ever used for its vpcId / cidr / AZ metadata. Populating the per-type
    // lists would require each to be a multiple of the AZ count, which our
    // asymmetric single-AZ subnet groups (bastion, monitoring, nlb) are not.
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'VpcRef', {
      vpcId: this.vpcId,
      availabilityZones: this.availabilityZones,
      vpcCidrBlock: props.env.vpcCidr,
    });
  }

  /** Returns the concrete subnet for a layout key (e.g. "private-portal-az-a"). */
  public subnet(key: string): ec2.Subnet {
    const s = this.subnets.get(key);
    if (!s) throw new Error(`Subnet "${key}" not found in VPC plan`);
    return s;
  }

  /** Returns concrete subnets for several keys (for multi-subnet placements). */
  public subnetsFor(keys: string[]): ec2.Subnet[] {
    return keys.map((k) => this.subnet(k));
  }

  // ---------------------------------------------------------------------------

  private createSubnet(spec: SubnetSpec): void {
    const az = this.availabilityZones[spec.azIndex];
    const cidr = subnetCidr(this.env.vpcCidr, spec.offset);
    const subnet = new ec2.Subnet(this, `Subnet-${spec.key}`, {
      vpcId: this.vpcId,
      availabilityZone: az,
      cidrBlock: cidr,
      mapPublicIpOnLaunch: false, // even public subnets only host ALB/NAT ENIs
    });
    Tags.of(subnet).add('Name', `${this.env.name}-esri-${spec.namePattern}`);
    Tags.of(subnet).add('Tier', spec.exposure);
    this.subnets.set(spec.key, subnet);
  }

  private createNatGateways(): void {
    for (let az = 0; az < 2; az++) {
      const natSubnet = this.subnets.get(`public-nat-az-${az === 0 ? 'a' : 'b'}`)!;
      const eip = new ec2.CfnEIP(this, `NatEip-${az}`, { domain: 'vpc' });
      const nat = new ec2.CfnNatGateway(this, `NatGateway-${az}`, {
        subnetId: natSubnet.subnetId,
        allocationId: eip.attrAllocationId,
        tags: [{ key: 'Name', value: `${this.env.name}-esri-nat-az-${az === 0 ? 'a' : 'b'}` }],
      });
      this.natGatewayIdByAz[az] = nat.ref;
    }
  }

  /** Returns the firewall VPC endpoint id per AZ index [az-a, az-b]. */
  private createNetworkFirewall(): string[] {
    const fwSubnets = [
      this.subnets.get('private-firewall-az-a')!,
      this.subnets.get('private-firewall-az-b')!,
    ];

    // Baseline stateful rule group: allow established TCP egress on common
    // ArcGIS dependency ports (HTTPS for Esri licensing, OS patching, vendor
    // access). Tighten the allow-list during detailed firewall implementation
    // (LLD 5.4.3 notes the outbound policy is allow-list based).
    const statefulGroup = new nf.CfnRuleGroup(this, 'FwStatefulAllow', {
      capacity: 100,
      ruleGroupName: `${this.env.name}-esri-egress-allow`,
      type: 'STATEFUL',
      ruleGroup: {
        rulesSource: {
          statefulRules: [
            {
              action: 'PASS',
              header: {
                protocol: 'TCP',
                source: this.env.vpcCidr,
                sourcePort: 'ANY',
                destination: 'ANY',
                destinationPort: '443',
                direction: 'FORWARD',
              },
              ruleOptions: [{ keyword: 'sid', settings: ['1'] }],
            },
          ],
        },
      },
    });

    const policy = new nf.CfnFirewallPolicy(this, 'FwPolicy', {
      firewallPolicyName: `${this.env.name}-esri-fw-policy`,
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulRuleGroupReferences: [{ resourceArn: statefulGroup.attrRuleGroupArn }],
      },
    });

    const firewall = new nf.CfnFirewall(this, 'Firewall', {
      firewallName: `${this.env.name}-esri-fw`,
      firewallPolicyArn: policy.attrFirewallPolicyArn,
      vpcId: this.vpcId,
      subnetMappings: fwSubnets.map((s) => ({ subnetId: s.subnetId })),
    });

    // attrEndpointIds entries are "az:vpce-id". Extract the vpce-id per AZ.
    // Index alignment to AZ is assumed to follow subnetMappings order; validate
    // during detailed firewall implementation.
    return [0, 1].map((i) =>
      Fn.select(1, Fn.split(':', Fn.select(i, firewall.attrEndpointIds))),
    );
  }

  private configureRouting(
    igw: ec2.CfnInternetGateway,
    firewallEndpointByAz?: string[],
  ): void {
    for (const spec of SUBNET_PLAN) {
      const subnet = this.subnets.get(spec.key)!;
      const azIdx = spec.azIndex;

      switch (spec.exposure) {
        case 'public': {
          // Public ALB and NAT subnets route to the Internet Gateway.
          subnet.addRoute('DefaultIgw', {
            routerType: ec2.RouterType.GATEWAY,
            routerId: igw.ref,
            destinationCidrBlock: '0.0.0.0/0',
          });
          break;
        }
        case 'isolated': {
          // Isolated data subnets: VPC-local only. No default route (LLD 5.3).
          break;
        }
        case 'private': {
          if (spec.routeTable === 'private-firewall') {
            // Firewall subnets egress to the NAT Gateway in the same AZ.
            subnet.addRoute('FwToNat', {
              routerType: ec2.RouterType.NAT_GATEWAY,
              routerId: this.natGatewayIdByAz[azIdx],
              destinationCidrBlock: '0.0.0.0/0',
            });
          } else if (spec.routeTable === 'private-nlb' || spec.routeTable === 'private-internal') {
            // Internal LB / NLB subnets: VPC-local only, no internet route (Table 5).
          } else if (firewallEndpointByAz) {
            // Inspected egress: workload subnets send 0.0.0.0/0 to the firewall
            // endpoint in the same AZ, which then forwards to NAT (LLD 5.4.3).
            subnet.addRoute('DefaultToFirewall', {
              routerType: ec2.RouterType.VPC_ENDPOINT,
              routerId: firewallEndpointByAz[azIdx],
              destinationCidrBlock: '0.0.0.0/0',
            });
          } else {
            // No firewall: workload subnets egress directly via NAT.
            subnet.addRoute('DefaultToNat', {
              routerType: ec2.RouterType.NAT_GATEWAY,
              routerId: this.natGatewayIdByAz[azIdx],
              destinationCidrBlock: '0.0.0.0/0',
            });
          }
          break;
        }
      }
    }
  }

  /**
   * Network ACLs per subnet class (LLD Table 25). NACLs are stateless, so for
   * subnet classes that egress to the internet via NAT we additionally allow
   * inbound ephemeral return traffic - a functional refinement over the coarse
   * "deny all inbound from internet" wording in the table.
   */
  private configureNacls(): void {
    const groups: Record<string, { exposures: SubnetExposure[]; keys: string[]; natEgress: boolean }>
      = {
        public: { exposures: ['public'], keys: this.keysFor((s) => s.exposure === 'public'), natEgress: true },
        'private-egress': {
          exposures: ['private'],
          keys: this.keysFor(
            (s) => s.exposure === 'private' &&
              !['private-nlb', 'private-internal'].includes(s.routeTable),
          ),
          natEgress: true,
        },
        'private-internal-only': {
          exposures: ['private'],
          keys: this.keysFor(
            (s) => s.exposure === 'private' &&
              ['private-nlb', 'private-internal'].includes(s.routeTable),
          ),
          natEgress: false,
        },
        isolated: { exposures: ['isolated'], keys: this.keysFor((s) => s.exposure === 'isolated'), natEgress: false },
      };

    for (const [name, group] of Object.entries(groups)) {
      if (group.keys.length === 0) continue;
      const acl = new ec2.CfnNetworkAcl(this, `Nacl-${name}`, {
        vpcId: this.vpcId,
        tags: [{ key: 'Name', value: `${this.env.name}-nacl-esri-${name}` }],
      });

      if (name === 'public') {
        // Inbound: HTTPS from internet, RDP (SG-constrained), ephemeral return.
        this.naclEntry(acl, name, 100, false, '0.0.0.0/0', 443, 443);
        this.naclEntry(acl, name, 110, false, '0.0.0.0/0', 3389, 3389);
        this.naclEntry(acl, name, 120, false, '0.0.0.0/0', 1024, 65535);
        // Outbound: all.
        this.naclEntry(acl, name, 100, true, '0.0.0.0/0');
      } else if (group.natEgress) {
        // Inbound: all VPC-internal + ephemeral return from internet (NAT).
        this.naclEntry(acl, name, 100, false, '10.0.0.0/8');
        this.naclEntry(acl, name, 110, false, '0.0.0.0/0', 1024, 65535);
        // Outbound: VPC-internal + internet (via firewall/NAT).
        this.naclEntry(acl, name, 100, true, '10.0.0.0/8');
        this.naclEntry(acl, name, 110, true, '0.0.0.0/0');
      } else {
        // Internal-only / isolated: VPC-internal both ways, no internet.
        this.naclEntry(acl, name, 100, false, '10.0.0.0/8');
        this.naclEntry(acl, name, 100, true, '10.0.0.0/8');
      }

      group.keys.forEach((key, i) => {
        new ec2.CfnSubnetNetworkAclAssociation(this, `NaclAssoc-${name}-${i}`, {
          networkAclId: acl.ref,
          subnetId: this.subnets.get(key)!.subnetId,
        });
      });
    }
  }

  private naclEntry(
    acl: ec2.CfnNetworkAcl,
    group: string,
    ruleNumber: number,
    egress: boolean,
    cidr: string,
    fromPort?: number,
    toPort?: number,
  ): void {
    new ec2.CfnNetworkAclEntry(this, `NaclEntry-${group}-${egress ? 'out' : 'in'}-${ruleNumber}`, {
      networkAclId: acl.ref,
      ruleNumber,
      protocol: fromPort !== undefined ? 6 /* TCP */ : -1 /* all */,
      ruleAction: 'allow',
      egress,
      cidrBlock: cidr,
      portRange: fromPort !== undefined ? { from: fromPort, to: toPort ?? fromPort } : undefined,
    });
  }

  private keysFor(predicate: (s: SubnetSpec) => boolean): string[] {
    return SUBNET_PLAN.filter(predicate).map((s) => s.key);
  }
}
