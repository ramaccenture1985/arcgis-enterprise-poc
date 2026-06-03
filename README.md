# XYZ Agotest Risk Platform — ArcGIS Enterprise CDK

AWS CDK (TypeScript) for the **ArcGIS Enterprise** tier of the Australian
Agotest Service (XYZ) Agotest Risk Platform, built from the project HLD and the Esri
Integration LLD. See **[architecture.md](architecture.md)** for the full design
narrative and the HLD-over-LLD decisions.

## What this deploys

Per environment (dev / test / uat / prod / dr), six stacks:

- `Xyz-Esri-<env>-Network` — VPC, subnets, routing, NACLs, AWS Network Firewall,
  VPC endpoints, Route 53 private zone, security groups
- `Xyz-Esri-<env>-Security` — KMS CMK, IAM roles, Secrets Manager
- `Xyz-Esri-<env>-Data` — RDS PostgreSQL (+replica), FSx, S3
- `Xyz-Esri-<env>-Compute` — 20 ArcGIS Enterprise EC2 instances
- `Xyz-Esri-<env>-LoadBalancers` — Public/Internal ALB, Private NLB, ACM, WAF
- `Xyz-Esri-<env>-ConnectivityTest` — VPC Lambda that probes cross-env reachability

See **[machines.md](machines.md)** for what every machine is, its size, and how
to remote in. dev/test use small PoC (t3 burstable) sizing; uat/prod/dr use the
LLD Table 30 sizing.

## Connectivity testing

```
aws lambda invoke --function-name <env>-esri-connectivity-test \
  --payload '{}' out.json && cat out.json
```
Probes the load balancers, RDS, and the S3/Secrets Manager/SSM endpoints, and
returns a per-target pass/fail summary.

## Prerequisites

- Node.js 20+ and the AWS CDK v2 toolkit
- AWS credentials for the target account, and `cdk bootstrap` run there
- AWS region: `ap-southeast-2` (Sydney)

## Commands

```bash
npm install
npm run build                          # tsc type-check (no emit issues)
npx cdk synth  -c env=dev              # synthesize one environment
npx cdk synth  -c env=all              # synthesize all five (default)
npx cdk diff   -c env=prod
npx cdk deploy -c env=prod --all       # deploy all stacks for prod
```

### Selecting account ids

Each environment is intended for its own application account (HLD §4.1):

```bash
npx cdk deploy -c env=prod -c account_prod=123456789012 --all
```

If omitted, `CDK_DEFAULT_ACCOUNT` (from your active credentials) is used.

## Configuration

All per-environment settings live in
[`lib/config/environments.ts`](lib/config/environments.ts):
CIDRs, instance sizing (LLD Table 30), firewall/FSx/Multi-AZ toggles,
deletion protection, internal/public domains.

Network layout (subnet offsets from LLD Table 4) is in
[`lib/config/network-layout.ts`](lib/config/network-layout.ts); ports in
[`lib/config/ports.ts`](lib/config/ports.ts).

## Pre-deployment checklist

These are placeholders/inputs to confirm before a real deploy:

1. **CIDR allocation** — confirm `10.0.0.0/20`-per-env with the Bureau network
   team (LLD §5.1 lists these as assumptions pending confirmation).
2. **Public domain** — replace the `<env>.xyz-agotest-platform.gov.au` placeholder
   (`publicDomain` in env config) with the approved XYZ domain; ACM DNS
   validation completes against that zone.
3. **AWS Client VPN CIDR** — set `clientVpnCidr` (defaults to `10.100.0.0/16`)
   to the real Client VPN client range for Bastion RDP access.
4. **FSx + Active Directory** — FSx for Windows is off by default. To enable,
   set `deployFsx: true` and provide an `activeDirectory` config (domain, DNS
   IPs, service-account secret).
5. **EBS CMK** — enable account-level EBS default encryption with the per-env
   KMS key if you require CMK (not default-key) encryption on instance volumes.
6. **Inbound firewall inspection** — add the IGW edge route table to complete
   inbound inspection (outbound inspection is already wired). See
   architecture.md §4.3.
7. **ArcGIS Monitor IAM user keys** — issue access keys out-of-band and store in
   Secrets Manager (the user + read-only policies are created by the stack).

## Project layout

```
bin/app.ts                      # entrypoint: wires 5 stacks per environment
lib/config/                     # environments, network layout, ports, naming
lib/constructs/
  esri-vpc.ts                   # VPC, subnets, routing, NACLs, firewall
  security-groups.ts            # full LLD security-group matrix
  arcgis-instance.ts            # standardised EC2 instance
lib/stacks/                     # network / security / data / loadbalancer / compute
architecture.md                 # design narrative + HLD/LLD decisions
```

## Notes

- This is infrastructure only. ArcGIS Enterprise software installation,
  federation and content configuration are performed post-provisioning (via
  SSM/automation) and are out of scope for the CDK.
- FME, Databricks, GraphDB and event-driven ingestion are separate pieces of the
  Platform and are not in this stack set.
