/**
 * Subnet layout for the ArcGIS Enterprise VPC.
 *
 * Encodes the LLD "Subnet design" (section 5.2, Table 4) as octet offsets within
 * an environment's /20 VPC CIDR. The LLD expresses subnets as ".X/Y" patterns
 * relative to the VPC base; this module turns the base CIDR into concrete subnet
 * CIDRs deterministically.
 *
 * AZ split convention (from the LLD): AZ-a workloads occupy third-octet values
 * 0-3 within the /20; AZ-b workloads occupy 4-7. Values 8-15 are reserved for
 * future growth, as called out in section 5.1.1.
 *
 * Two deviations from the literal Table 4 are applied to honour the HLD's
 * dual-AZ HA posture (HLD section 2.2.1.1 / 5) and AWS hard requirements:
 *   - The Public ALB requires subnets in >= 2 AZs, so a public-alb-az-b subnet
 *     is added (Table 4 listed it Single-AZ).
 *   - The Internal ALB requires subnets in >= 2 AZs, so a private-internal-az-b
 *     subnet is added (Table 4 listed it Single-AZ).
 * These are documented in architecture.md.
 */

export type SubnetExposure = 'public' | 'private' | 'isolated';

export interface SubnetSpec {
  /** Logical group key used throughout the codebase. */
  readonly key: string;
  /** Name pattern from LLD Table 4 (the `subnet-esri-...` name, minus env prefix). */
  readonly namePattern: string;
  /** Exposure model: drives routing (IGW / NAT / none) and NACL posture. */
  readonly exposure: SubnetExposure;
  /** AZ index: 0 = AZ-a, 1 = AZ-b. */
  readonly azIndex: 0 | 1;
  /**
   * CIDR offset within the /20 VPC, expressed as [thirdOctetOffset, fourthOctet, prefixLength].
   * Actual CIDR = base.[base3 + thirdOctetOffset].[fourthOctet]/prefixLength
   */
  readonly offset: { thirdOctet: number; fourthOctet: number; prefix: number };
  /** Which logical route table this subnet attaches to (LLD section 5.3, Table 5). */
  readonly routeTable: RouteTableKey;
}

export type RouteTableKey =
  | 'public-alb'
  | 'public-nat'
  | 'private-bastion'
  | 'private-portal'
  | 'private-services'
  | 'isolated-data'
  | 'private-monitoring'
  | 'private-nlb'
  | 'private-internal'
  | 'private-firewall';

/**
 * The complete subnet plan. Order is significant only for readability.
 * Mirrors LLD Table 4 plus the two HLD-driven AZ-b additions noted above.
 */
export const SUBNET_PLAN: SubnetSpec[] = [
  // --- Public tier (route to IGW) ---
  { key: 'public-alb-az-a', namePattern: 'public-alb-az-a', exposure: 'public', azIndex: 0, offset: { thirdOctet: 0, fourthOctet: 0, prefix: 26 }, routeTable: 'public-alb' },
  // HLD-driven addition (dual-AZ ALB requirement):
  { key: 'public-alb-az-b', namePattern: 'public-alb-az-b', exposure: 'public', azIndex: 1, offset: { thirdOctet: 4, fourthOctet: 0, prefix: 26 }, routeTable: 'public-alb' },
  { key: 'public-nat-az-a', namePattern: 'public-nat-az-a', exposure: 'public', azIndex: 0, offset: { thirdOctet: 0, fourthOctet: 64, prefix: 27 }, routeTable: 'public-nat' },
  { key: 'public-nat-az-b', namePattern: 'public-nat-az-b', exposure: 'public', azIndex: 1, offset: { thirdOctet: 4, fourthOctet: 64, prefix: 27 }, routeTable: 'public-nat' },

  // --- Private tier (route to NAT via firewall inspection) ---
  { key: 'private-bastion-az-a', namePattern: 'private-bastion-az-a', exposure: 'private', azIndex: 0, offset: { thirdOctet: 0, fourthOctet: 96, prefix: 27 }, routeTable: 'private-bastion' },
  { key: 'private-portal-az-a', namePattern: 'private-portal-az-a', exposure: 'private', azIndex: 0, offset: { thirdOctet: 1, fourthOctet: 0, prefix: 25 }, routeTable: 'private-portal' },
  { key: 'private-portal-az-b', namePattern: 'private-portal-az-b', exposure: 'private', azIndex: 1, offset: { thirdOctet: 5, fourthOctet: 0, prefix: 25 }, routeTable: 'private-portal' },
  { key: 'private-services-az-a', namePattern: 'private-services-az-a', exposure: 'private', azIndex: 0, offset: { thirdOctet: 2, fourthOctet: 0, prefix: 24 }, routeTable: 'private-services' },
  { key: 'private-services-az-b', namePattern: 'private-services-az-b', exposure: 'private', azIndex: 1, offset: { thirdOctet: 6, fourthOctet: 0, prefix: 24 }, routeTable: 'private-services' },
  { key: 'private-monitoring-az-a', namePattern: 'private-monitoring-az-a', exposure: 'private', azIndex: 0, offset: { thirdOctet: 0, fourthOctet: 128, prefix: 27 }, routeTable: 'private-monitoring' },
  { key: 'private-nlb-az-a', namePattern: 'private-nlb-az-a', exposure: 'private', azIndex: 0, offset: { thirdOctet: 0, fourthOctet: 160, prefix: 27 }, routeTable: 'private-nlb' },
  { key: 'private-internal-az-a', namePattern: 'private-internal-az-a', exposure: 'private', azIndex: 0, offset: { thirdOctet: 0, fourthOctet: 192, prefix: 27 }, routeTable: 'private-internal' },
  // HLD-driven addition (dual-AZ internal ALB requirement):
  { key: 'private-internal-az-b', namePattern: 'private-internal-az-b', exposure: 'private', azIndex: 1, offset: { thirdOctet: 4, fourthOctet: 192, prefix: 27 }, routeTable: 'private-internal' },
  { key: 'private-firewall-az-a', namePattern: 'private-firewall-az-a', exposure: 'private', azIndex: 0, offset: { thirdOctet: 0, fourthOctet: 224, prefix: 27 }, routeTable: 'private-firewall' },
  { key: 'private-firewall-az-b', namePattern: 'private-firewall-az-b', exposure: 'private', azIndex: 1, offset: { thirdOctet: 4, fourthOctet: 224, prefix: 27 }, routeTable: 'private-firewall' },

  // --- Isolated tier (no IGW, no NAT) ---
  { key: 'isolated-data-az-a', namePattern: 'isolated-data-az-a', exposure: 'isolated', azIndex: 0, offset: { thirdOctet: 3, fourthOctet: 0, prefix: 26 }, routeTable: 'isolated-data' },
  { key: 'isolated-data-az-b', namePattern: 'isolated-data-az-b', exposure: 'isolated', azIndex: 1, offset: { thirdOctet: 7, fourthOctet: 0, prefix: 26 }, routeTable: 'isolated-data' },
];

/**
 * Computes the concrete CIDR for a subnet given the VPC base CIDR (a /20).
 * e.g. base "10.0.32.0/20" + offset {3:1,4:0,/25} => "10.0.33.0/25".
 */
export function subnetCidr(vpcBaseCidr: string, offset: SubnetSpec['offset']): string {
  const [network] = vpcBaseCidr.split('/');
  const octets = network.split('.').map((o) => parseInt(o, 10));
  const third = octets[2] + offset.thirdOctet;
  return `${octets[0]}.${octets[1]}.${third}.${offset.fourthOctet}/${offset.prefix}`;
}

/** Convenience: return all subnet specs that attach to a given route table. */
export function subnetsForRouteTable(rt: RouteTableKey): SubnetSpec[] {
  return SUBNET_PLAN.filter((s) => s.routeTable === rt);
}
