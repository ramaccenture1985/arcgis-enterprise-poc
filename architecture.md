# XYZ Agotest Risk Platform — ArcGIS Enterprise on AWS (CDK)

This document describes the architecture implemented by this CDK project. It is
the **ArcGIS Enterprise piece** of the broader Australian Agotest Service (XYZ)
Agotest Risk Platform — i.e. the geospatial platform (green/blue tiers of the HLD
architecture diagram). The FME/ETL, Databricks, GraphDB and event-driven
ingestion pieces are intentionally **out of scope** for this stack set.

It is built from two reference documents:

- **HLD** — *SUBMISSION D0.04 AWS High-Level Design* (v0.2)
- **LLD** — *DRAFT D0.08 AWS Design – Esri Integration* (v0.1)

Where the two disagree, the **HLD takes precedence** (per the brief). Those
decisions are called out explicitly in [§9 HLD-over-LLD decisions](#9-hld-over-lld-decisions).

---

## 1. Solution at a glance

A DMZ-aligned, multi-AZ ArcGIS Enterprise deployment in `ap-southeast-2`
(Sydney), one self-contained instance per environment. Internet traffic enters
only through a WAF-protected public ALB; every ArcGIS component runs in private
or isolated subnets with no direct inbound internet exposure. Administrative
access is via a Bastion reachable only over AWS Client VPN.

```
Internet
   │  (Route 53 + WAF)
   ▼
Public ALB ──► Portal Web Adaptor ──► Portal (primary/secondary, HA)
                                          │ federation (Internal ALB :443)
API Gateway ─► Private NLB ─► ArcGIS Server Web Adaptor ─► ArcGIS Server site
                                          │
Internal ALB ─► ArcGIS Server / Image Server Web Adaptors
                                          ▼
                            ArcGIS Data Store (isolated)   RDS PostgreSQL (isolated)
                            FSx (config stores / file DS)   S3 (object/image/backup)
```

Per-environment AWS Network Firewall inspects all workload egress (and is the
intended inbound inspection layer); KMS encrypts data at rest; CloudWatch +
ArcGIS Monitor provide observability.

---

## 2. Environments

Five environments, each a dedicated VPC in its own application account
(HLD §4.1 network-isolated hosting model):

| Env  | VPC CIDR        | Grade        | Firewall | RDS Multi-AZ + replica | Deletion protection | Source |
|------|-----------------|--------------|----------|------------------------|---------------------|--------|
| dev  | `10.0.0.0/20`   | reduced size | off      | no                     | no                  | LLD Table 3 |
| test | `10.0.16.0/20`  | reduced size | off      | no                     | no                  | LLD Table 3 |
| uat  | `10.0.32.0/20`  | full size    | on       | yes                    | yes                 | LLD Table 3 |
| prod | `10.0.48.0/20`  | full size    | on       | yes                    | yes                 | LLD Table 3 |
| **dr** | **`10.0.64.0/20`** | **full size** | **on** | **yes**            | **yes**             | **HLD-driven** |

`dev`/`test` use **small PoC sizing** (t3 burstable — `t3.large`/`t3.medium`/
`t3.small`, just enough to install and run ArcGIS) and skip the firewall/Multi-AZ
to keep non-production lean (LLD §2.3, §6.1). `uat`/`prod`/`dr` run the full
Table 30 sizing. **DR is added per the HLD** (see [§9](#9-hld-over-lld-decisions))
and mirrors Production. Per-machine detail is in [machines.md](machines.md).

All environment configuration lives in [`lib/config/environments.ts`](lib/config/environments.ts).

---

## 3. Stack structure

The deployment is split into six stacks per environment (created by
[`bin/app.ts`](bin/app.ts)). Dependencies form a clean DAG:

```
NetworkStack ──┬──► DataStack ─────────┐
               ├──► SecurityStack ──────┤
               ├──► ComputeStack ───────┴──► LoadBalancerStack ──► ConnectivityTestStack
```

| Stack | Responsibility | LLD section |
|-------|----------------|-------------|
| **NetworkStack** | VPC, subnets, routing, NACLs, AWS Network Firewall, VPC endpoints, Route 53 private zone, the full security-group matrix | §5 |
| **SecurityStack** | KMS CMK, IAM roles (Table 45), Secrets Manager secrets | §9 |
| **DataStack** | RDS PostgreSQL (+read replica), FSx for Windows, S3 buckets | §7 |
| **ComputeStack** | All ArcGIS Enterprise EC2 instances (Table 30), key pair, CloudWatch agent | §4.2, §6 |
| **LoadBalancerStack** | Public/Internal ALB, Private NLB, target groups, ACM, WAF; registers Web Adaptors | §8 |
| **ConnectivityTestStack** | VPC-attached Lambda probing TCP reachability to LBs, RDS and AWS endpoints | — |

> **Why LoadBalancerStack depends on ComputeStack:** target groups (LB) and
> EC2 instances (Compute) reference each other. To avoid a cross-stack cycle,
> Compute is created first and exposes its Web Adaptor instances; the LB stack
> registers them into its target groups.

---

## 4. Network design (LLD §5)

Implemented by [`lib/constructs/esri-vpc.ts`](lib/constructs/esri-vpc.ts) using
the subnet plan in [`lib/config/network-layout.ts`](lib/config/network-layout.ts).

### 4.1 Subnets (LLD Table 4)

Each `/20` VPC is carved into explicit subnets at the exact octet offsets from
Table 4. The AZ split convention from the LLD is preserved: AZ-a workloads in
third-octet `0–3`, AZ-b in `4–7`, leaving `8–15` for growth.

| Subnet group | Exposure | AZs | Example CIDR (prod) |
|--------------|----------|-----|---------------------|
| public-alb | public | a, **b** | `10.0.48.0/26`, `10.0.52.0/26` |
| public-nat | public | a, b | `10.0.48.64/27`, `10.0.52.64/27` |
| private-bastion | private | a | `10.0.48.96/27` |
| private-portal | private | a, b | `10.0.49.0/25`, `10.0.53.0/25` |
| private-services | private | a, b | `10.0.50.0/24`, `10.0.54.0/24` |
| private-monitoring | private | a | `10.0.48.128/27` |
| private-nlb | private | a | `10.0.48.160/27` |
| private-internal | private | a, **b** | `10.0.48.192/27`, `10.0.52.192/27` |
| private-firewall | private | a, b | `10.0.48.224/27`, `10.0.52.224/27` |
| isolated-data | isolated | a, b | `10.0.51.0/26`, `10.0.55.0/26` |

The **public-alb-az-b** and **private-internal-az-b** subnets are HLD-driven
additions (ALBs require ≥2 AZs) — see [§9](#9-hld-over-lld-decisions).

### 4.2 Routing (LLD Table 5)

- **public** → Internet Gateway
- **isolated-data** → VPC-local only (no IGW, no NAT)
- **private-nlb / private-internal** → VPC-local only
- **private workloads** (portal/services/bastion/monitoring) → default route to
  the **AWS Network Firewall endpoint** in the same AZ, which forwards to NAT
  (inspected egress). When the firewall is disabled (dev/test) they route
  directly to NAT.
- **private-firewall** → NAT Gateway (post-inspection egress)

### 4.3 AWS Network Firewall (LLD §5.4)

When enabled, a Network Firewall with stateful policy is deployed across both
firewall subnets. **Outbound inspection** is fully wired: workload subnets send
`0.0.0.0/0` to the firewall endpoint before NAT. The baseline stateful rule
group passes established HTTPS egress (Esri licensing, OS patching, vendor
access) and is intended to be tightened to an allow-list during detailed
implementation, as the LLD itself notes (§5.4.3).

> **Inbound inspection** (IGW → firewall → public ALB) requires an IGW *edge*
> route table, which AWS Network Firewall route management or a follow-up
> change adds; the firewall and endpoints provisioned here are the prerequisite.
> This is the one firewall element deferred, consistent with the LLD's note
> that "final route entries depend on the detailed firewall implementation".

### 4.4 Network ACLs (LLD Table 25)

Coarse subnet-boundary controls, complementing the security groups:

- **public**: inbound 443 + RDP + ephemeral return; outbound all.
- **private (NAT-egress)**: inbound from `10.0.0.0/8` + ephemeral return from
  internet (needed for NAT return traffic); outbound to VPC + internet.
- **private internal-only / isolated**: VPC-internal both directions, no internet.

> The ephemeral-return inbound rule is a functional refinement over the LLD's
> coarse "deny all inbound from internet" wording — without it, NAT return
> traffic would be dropped. Noted as an engineering correctness item.

### 4.5 VPC endpoints (LLD Table 26)

- **S3** — Gateway endpoint, associated with the bastion/portal/services/
  monitoring/isolated route tables.
- **SSM, SSM Messages, EC2 Messages, Secrets Manager, CloudWatch Logs, KMS** —
  Interface endpoints in the private workload subnets, fronted by a dedicated
  HTTPS-from-VPC security group.

### 4.6 Route 53 (LLD §5.8)

A private hosted zone per environment (`<env>.arcgis.internal`) for internal
service resolution (`portal.<env>.arcgis.internal`, `ags.…`, etc.).

---

## 5. Security groups (LLD Tables 8–24)

The complete instance-level traffic matrix is in
[`lib/constructs/security-groups.ts`](lib/constructs/security-groups.ts). All 18
component security groups plus the interface-endpoint SG are created with
`allowAllOutbound: false`, so every egress path is explicit and least-privilege.

Highlights:

- **sg-alb-public** — 443 from internet (post-WAF); forwards to Portal WA.
- **sg-portal / sg-ags / sg-image** — Web-Adaptor ingress on 7443/6443, HA
  replication ranges (5701–5801, 4181–4190), Bastion RDP, Monitor health.
- **sg-datastore** — 2443 from ArcGIS Server, replication 9820/9840/9850,
  webhooks 45671/45672, PostgreSQL egress to RDS.
- **sg-rds / sg-rds-replica** — 5432 from Data Store (and ArcGIS Server).
- **sg-cs-portal/ags/image** — SMB 445 config-store access.
- **sg-bastion** — RDP only from the AWS Client VPN CIDR; fans out RDP to all
  components. **sg-monitor** — polls every component's health endpoint.

Two placeholder groups (**sg-app**, **sg-fme**) are created for the out-of-scope
serverless/FME integration that the matrix references, so the Internal-ALB and
ArcGIS-Server rules remain complete.

A handful of rules are added beyond the literal table where the LLD's own
component design (§4.2) requires them to function — each is commented inline
(e.g. Portal→Internal-ALB federation, ArcGIS-Server→RDS, Image-WA via Internal
ALB).

---

## 6. Compute (LLD §4.2, Table 30)

[`lib/stacks/compute-stack.ts`](lib/stacks/compute-stack.ts) +
[`lib/constructs/arcgis-instance.ts`](lib/constructs/arcgis-instance.ts).

20 EC2 instances per environment, Windows Server 2022 base AMI (§6.2),
gp3 root volumes, IMDSv2 required:

| Component | Count | Subnet | SG | Instance (prod) |
|-----------|-------|--------|----|-----------------|
| Portal Web Adaptor | 2 | private-portal a/b | sg-portal-webadaptor | m6i.large |
| Portal (primary/secondary) | 2 | private-portal a/b | sg-portal | m6i.xlarge |
| ArcGIS Server Web Adaptor | 2 | private-services a/b | sg-ags-webadaptor | m6i.large |
| ArcGIS Server (hosting + az-b) | 2 | private-services a/b | sg-ags | m6i.2xlarge |
| Image Server Web Adaptor | 2 | private-services a/b | sg-image-webadaptor | m6i.large |
| Image Server | 2 | private-services a/b | sg-image | c6i.2xlarge |
| Notebook Server | 1 | private-services a | sg-notebook | m6i.2xlarge |
| Data Store (primary/standby) | 2 | isolated-data a/b | sg-datastore | r6i.xlarge |
| Config Stores (portal/ags/image) | 3 | private-services a | sg-cs-* | m6i.large |
| ArcGIS Monitor | 1 | private-monitoring a | sg-monitor | m6i.large |
| Bastion | 1 | private-bastion a | sg-bastion | m6i.large |

Scaling follows the LLD's ad-hoc manual model (§6.3): ArcGIS Server/Image/Portal
scale horizontally by joining new nodes to the existing site; Web Adaptors are a
fixed tier; managed services (RDS/FSx/S3) scale independently.

> **Config stores as EC2 instances:** the LLD is internally inconsistent —
> Table 30, the architecture diagram and the security-group matrix model the
> three config stores as dedicated EC2 instances, while §7.2.2 describes the
> config store *content* as living on FSx Drive 1. We followed the majority
> (instances + their `sg-cs-*` groups), with FSx Drive 1 hosting the shared
> config directory the instances reference.

---

## 7. Data tier (LLD §7)

[`lib/stacks/data-stack.ts`](lib/stacks/data-stack.ts).

- **RDS PostgreSQL** (Enterprise Geodatabase) — gp3, KMS-encrypted, Multi-AZ +
  read replica in prod/uat/dr, 7-day PITR, storage autoscaling, in the isolated
  data subnets. Credentials auto-generated into Secrets Manager.
- **FSx for Windows** — Drive 1 (config stores) and Drive 2 (file data store),
  single-AZ, SMB, KMS-encrypted, 7-day backups. **AD-gated:** only deployed when
  an `activeDirectory` config is supplied (FSx for Windows requires AD). Off by
  default in this POC; the code path is complete and documented.
- **S3 buckets** — object store, image store (KMS, versioned), data store backup
  (KMS, versioned, Glacier-IR @90d, expire @7y), and an ALB access-logs bucket
  (SSE-S3, since ALB log delivery does not support a CMK).

---

## 8. Ingress & security services (LLD §8, §9)

[`lib/stacks/load-balancer-stack.ts`](lib/stacks/load-balancer-stack.ts) and
[`lib/stacks/security-stack.ts`](lib/stacks/security-stack.ts).

- **Public ALB** — internet-facing, WAF-attached, HTTPS 443 (+ HTTP→HTTPS
  redirect), round-robin, access logs, → Portal Web Adaptor target group.
- **Internal ALB** — private, HTTPS 443 → ArcGIS Server Web Adaptor, with an
  Image Server path rule.
- **Private NLB** — TCP 443 (API Gateway → ArcGIS Server WA), security-group
  attached.
- **Target groups** — section 8.4 health-check baseline (HTTPS, 200, 3/3
  thresholds, 30s/5s, 60s dereg).
- **ACM** — one approved wildcard certificate for both ALB listeners
  (per §8.5.1). `publicDomain` is a placeholder to be replaced with the approved
  XYZ domain.
- **AWS WAF** — managed rule groups (Common, KnownBadInputs, SQLi, IP-reputation,
  AnonymousIp) + a rate-based rule, associated to the Public ALB only (Tables
  43/44).
- **KMS** — one customer-managed key per environment (encryption at rest, §9.5).
- **IAM** — least-privilege roles per Table 45 (`role-arcgis-portal/server/
  image/notebook/ec2-base/backup` + a read-only ArcGIS-Monitor IAM user). S3
  permissions are scoped to deterministic bucket ARNs so SecurityStack stays
  decoupled from DataStack.
- **Secrets Manager** — primary site administrator + portal administrator
  secrets, CMK-encrypted; RDS master secret generated in the data stack.

---

## 9. HLD-over-LLD decisions

Where the documents conflicted, the HLD won. Each is flagged in code:

| # | Conflict | LLD said | HLD said | Decision |
|---|----------|----------|----------|----------|
| 1 | **DR environment** | 4 envs (dev/test/uat/prod), no DR | DR posture expected | Added a 5th **DR** environment (`10.0.64.0/20`) mirroring Production. |
| 2 | **Public ALB AZs** | public-alb Single-AZ (Table 4) | "two availability zones", ALB as sole entry with AZ redundancy | Public ALB spans **2 AZs** (added `public-alb-az-b`); AWS also requires ≥2 AZs for an ALB. |
| 3 | **Internal ALB AZs** | private-internal Single-AZ (Table 4) | dual-AZ HA | Internal ALB spans **2 AZs** (added `private-internal-az-b`). |

Other documented engineering refinements (not strictly HLD/LLD conflicts):

- **Config stores** modelled as EC2 instances (majority of LLD evidence) — §6.
- **NACL ephemeral-return** rules added so NAT egress return traffic isn't
  dropped — §4.4.
- **Inbound firewall inspection** deferred to an IGW edge route table — §4.3.
- **EBS CMK**: instance root volumes are encrypted with the default EBS key via
  the L2 construct; to use the per-env CMK, enable account-level EBS default
  encryption with that key (or migrate to a launch template that sets
  `KmsKeyId`).

---

## 10. Mapping to the requirements

| Requirement theme | Where implemented |
|-------------------|-------------------|
| Data within Australian jurisdiction (FR 4.2.1/4.2.2.d) | `region: ap-southeast-2` everywhere |
| MVP enterprise platform / ArcGIS Enterprise (FR 3.6.1.A.iii) | Compute + Network + LB stacks |
| AGOL↔Enterprise connectivity (FR 4.2.2.g, TRA 3.6.1.A.ix.a) | Public ALB / API Gateway entry points, ACM TLS |
| Secure against vulnerabilities (FR 3.10.1.b, NFR 38) | WAF, Network Firewall, NACLs, SGs, KMS, IMDSv2 |
| Multi-node availability & load distribution (NFR 66/67/68) | Multi-AZ subnets, ALB/NLB round-robin, HA SGs |
| Encryption in transit/at rest (NFR 34/35, SNFR-005/006) | ACM TLS, KMS CMK, RDS/S3/FSx/EBS encryption |
| User/identity management (FR 3.8.3f.2, §9.3) | IAM roles, Identity Center federation (design), Secrets |
| Monitoring (NFR 54–62) | CloudWatch (Logs/agent), ArcGIS Monitor instance + SG |

---

## 11. Running it

```bash
npm install
npm run build                       # type-check
npx cdk synth -c env=prod           # synthesize one environment
npx cdk synth -c env=all            # synthesize all five
npx cdk deploy -c env=prod --all    # deploy (needs bootstrapped account + creds)
```

Provide account ids via context (`-c account_prod=123456789012`) or rely on
`CDK_DEFAULT_ACCOUNT`. See [README.md](README.md) for details and the
pre-deployment checklist (domain, AD for FSx, Client VPN CIDR).
