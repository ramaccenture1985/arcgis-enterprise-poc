# Machines — XYZ Agotest Risk Platform (ArcGIS Enterprise)

This document describes every EC2 machine the deployment creates, what runs on
it, where it sits, and how to get onto it. It also lists the managed components
(RDS, S3, load balancers, the connectivity-test Lambda) that the machines depend
on.

All machines run **Windows Server 2022** (base AMI). ArcGIS software is **not**
pre-installed — these are the hosts an Esri engineer installs onto.

There are **20 EC2 instances per environment**.

---

## How to get onto a machine

No instance is exposed to the internet. Two access paths:

1. **AWS Systems Manager (recommended, no VPN):** every instance runs the SSM
   agent and has the SSM role. Use **Fleet Manager → Remote Desktop** in the
   console, or port-forward and use a local RDP client:
   ```
   aws ssm start-session --target <instance-id> \
     --document-name AWS-StartPortForwardingSession \
     --parameters portNumber=3389,localPortNumber=13389
   # then RDP to localhost:13389
   ```
2. **Bastion jump host:** reach the Bastion via SSM, then RDP-hop to any app
   server (the security groups already permit Bastion→component RDP).

**Windows credentials:** each instance has the built-in local **Administrator**.
Retrieve its password from the EC2 console ("Get Windows password") using the
per-environment key pair `<env>-esri-admin` (private key is in SSM Parameter
Store at `/ec2/keypair/<key-pair-id>`). No domain join yet (local accounts only).

**Staging installers:** drop ArcGIS setups in the `installers/` prefix of the
`object-store` S3 bucket — every instance role can read it — or copy over RDP.

---

## Sizing

Two profiles. **dev/test is the PoC profile** (small, burstable, just enough to
install and run the software). **uat/prod/dr keep the LLD Table 30 sizing.**

| Logical machine | PoC size (dev/test) | Full size (uat/prod/dr) |
|-----------------|---------------------|--------------------------|
| Portal Web Adaptor | t3.medium (4 GiB) | m6i.large |
| Portal | t3.large (8 GiB) | m6i.xlarge |
| ArcGIS Server Web Adaptor | t3.medium | m6i.large |
| ArcGIS Server | t3.large | m6i.2xlarge |
| Image Server Web Adaptor | t3.medium | m6i.large |
| Image Server | t3.large | c6i.2xlarge |
| Notebook Server | t3.large | m6i.2xlarge |
| Data Store | t3.large | r6i.xlarge |
| Config Store (×3) | t3.medium | m6i.large |
| ArcGIS Monitor | t3.medium | m6i.large |
| Bastion | t3.small (2 GiB) | m6i.large |
| RDS PostgreSQL | db.t3.medium | db.m6i.xlarge |

> t3 (burstable) is fine for a PoC; not recommended for sustained production
> load. Core ArcGIS components sit at 8 GiB (Esri's minimum RAM).

---

## The 20 machines

All instances: gp3 root volume, encrypted with the per-env KMS CMK; IMDSv2
required; SSM + CloudWatch agent enabled.

### Portal tier — `private-portal` subnets

| # | Instance id tag | Purpose / software | AZ | Subnet | Security group | IAM role | Root vol |
|---|-----------------|--------------------|----|--------|----------------|----------|----------|
| 1 | `wa-portal-az-a` | **Portal Web Adaptor** — IIS reverse proxy fronting Portal, terminates the public ALB path on 7443→Portal | a | private-portal-az-a | sg-portal-webadaptor | role-arcgis-ec2-base | 100 GiB |
| 2 | `wa-portal-az-b` | Portal Web Adaptor (2nd AZ) | b | private-portal-az-b | sg-portal-webadaptor | role-arcgis-ec2-base | 100 GiB |
| 3 | `portal-primary` | **Portal for ArcGIS** (primary) — web GUI, item catalogue, users/groups, federation point | a | private-portal-az-a | sg-portal | role-arcgis-portal | 150 GiB |
| 4 | `portal-secondary` | Portal for ArcGIS (standby, HA) | b | private-portal-az-b | sg-portal | role-arcgis-portal | 150 GiB |

### ArcGIS Server tier — `private-services` subnets

| # | Instance id tag | Purpose / software | AZ | Subnet | Security group | IAM role | Root vol |
|---|-----------------|--------------------|----|--------|----------------|----------|----------|
| 5 | `wa-ags-az-a` | **ArcGIS Server Web Adaptor** — fronts the hosting Server site (Internal ALB + NLB paths) | a | private-services-az-a | sg-ags-webadaptor | role-arcgis-ec2-base | 100 GiB |
| 6 | `wa-ags-az-b` | ArcGIS Server Web Adaptor (2nd AZ) | b | private-services-az-b | sg-ags-webadaptor | role-arcgis-ec2-base | 100 GiB |
| 7 | `ags-hosting-az-a` | **ArcGIS Server** (hosting server) — map/feature/geoprocessing services for hosted layers | a | private-services-az-a | sg-ags | role-arcgis-server | 200 GiB |
| 8 | `ags-az-b` | ArcGIS Server node 2 (same site, HA) | b | private-services-az-b | sg-ags | role-arcgis-server | 200 GiB |

### Image Server tier — `private-services` subnets

| # | Instance id tag | Purpose / software | AZ | Subnet | Security group | IAM role | Root vol |
|---|-----------------|--------------------|----|--------|----------------|----------|----------|
| 9 | `wa-image-az-a` | **Image Server Web Adaptor** | a | private-services-az-a | sg-image-webadaptor | role-arcgis-ec2-base | 100 GiB |
| 10 | `wa-image-az-b` | Image Server Web Adaptor (2nd AZ) | b | private-services-az-b | sg-image-webadaptor | role-arcgis-ec2-base | 100 GiB |
| 11 | `image-az-a` | **ArcGIS Image Server** — dynamic image services + raster analysis (reads S3 image store) | a | private-services-az-a | sg-image | role-arcgis-image | 200 GiB |
| 12 | `image-az-b` | ArcGIS Image Server node 2 (HA) | b | private-services-az-b | sg-image | role-arcgis-image | 200 GiB |

### Notebook, Data Store, Config Stores

| # | Instance id tag | Purpose / software | AZ | Subnet | Security group | IAM role | Root vol |
|---|-----------------|--------------------|----|--------|----------------|----------|----------|
| 13 | `notebook` | **ArcGIS Notebook Server** — Jupyter/Python execution (single-AZ per Esri guidance) | a | private-services-az-a | sg-notebook | role-arcgis-notebook | 200 GiB |
| 14 | `datastore-primary` | **ArcGIS Data Store** — relational store (primary). Data on the EBS volume → **volume preserved on terminate** | a | isolated-data-az-a | sg-datastore | role-arcgis-ec2-base | 200 GiB |
| 15 | `datastore-standby` | ArcGIS Data Store (standby; inverse primary/standby roles across AZs) | b | isolated-data-az-b | sg-datastore | role-arcgis-ec2-base | 200 GiB |
| 16 | `config-store-portal` | **Portal config store** host (shared config directory) | a | private-services-az-a | sg-cs-portal | role-arcgis-ec2-base | 100 GiB |
| 17 | `config-store-ags` | **ArcGIS Server config store** host | a | private-services-az-a | sg-cs-ags | role-arcgis-ec2-base | 100 GiB |
| 18 | `config-store-image` | **Image Server config store** host | a | private-services-az-a | sg-cs-image | role-arcgis-ec2-base | 100 GiB |

> Config stores are modelled as EC2 instances (per LLD Table 30 / diagram / SG
> matrix). When FSx is enabled, the shared config directory lives on FSx Drive 1
> and these hosts reference it. See architecture.md §6.

### Operations

| # | Instance id tag | Purpose / software | AZ | Subnet | Security group | IAM role | Root vol |
|---|-----------------|--------------------|----|--------|----------------|----------|----------|
| 19 | `monitor` | **ArcGIS Monitor** — polls health of all ArcGIS components | a | private-monitoring-az-a | sg-monitor | role-arcgis-ec2-base | 100 GiB |
| 20 | `bastion` | **Bastion / jump host** — administrative RDP entry (via SSM/VPN), RDP-hops to all components | a | private-bastion-az-a | sg-bastion | role-arcgis-ec2-base | 100 GiB |

---

## Managed components the machines depend on (not EC2)

| Component | What it is | Where | Notes |
|-----------|------------|-------|-------|
| **RDS PostgreSQL** | Enterprise Geodatabase (`sde`). Multi-AZ + read replica in uat/prod/dr | isolated-data subnets | KMS-encrypted, 7-day PITR. ArcGIS Server connects on 5432 |
| **S3 object-store** | Hosted layer/scene/tile cloud store + `installers/` staging | regional | KMS, versioned |
| **S3 image-store** | Image Server registered cloud store (rasters) | regional | KMS |
| **S3 datastore-backup** | Data Store backup target | regional | KMS, versioned, Glacier-IR @90d |
| **FSx for Windows** | Drive 1 config stores / Drive 2 file data store | isolated-data | **AD-gated, off by default** |
| **Public ALB** | Internet entry → Portal Web Adaptor (WAF in front) | public-alb subnets | HTTPS 443 |
| **Internal ALB** | Portal↔Server federation + Image WA path | private-internal subnets | HTTPS 443 |
| **Private NLB** | API Gateway → ArcGIS Server WA | private-nlb subnet | TCP 443 |
| **Connectivity-test Lambda** | TCP-reachability probe across the env | private-services subnets, sg-conntest | see below |

---

## Connectivity-test Lambda

`<env>-esri-connectivity-test` (deployed by `…-ConnectivityTest`) probes TCP
reachability to the load balancers, RDS endpoints, and the AWS service endpoints
(S3 gateway, Secrets Manager / SSM interface endpoints). Use it to confirm the
routing, security groups and VPC endpoints permit the intended flows.

```
aws lambda invoke --function-name <env>-esri-connectivity-test \
  --payload '{}' out.json && cat out.json
```

Returns per-target `ok` / `latency_ms` / `error` plus a pass/fail summary. You
can override the target list with `{"targets":[{"name":"x","host":"...","port":443}]}`.
