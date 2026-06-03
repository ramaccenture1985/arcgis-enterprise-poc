/**
 * Port constants for the ArcGIS Enterprise deployment.
 *
 * Sourced from the LLD "Security group matrix" (section 5.5, Tables 8-24) and
 * the per-component design (section 4.2). Centralised here so the security-group
 * rules read clearly and stay consistent.
 */
export const Ports = {
  /** HTTPS - ALB/NLB listeners, Web Adaptor, generic AWS service endpoints. */
  HTTPS: 443,
  /** HTTP - optional Public ALB redirect to HTTPS. */
  HTTP: 80,
  /** RDP - administrative access from the Bastion to all Windows EC2. */
  RDP: 3389,
  /** Portal for ArcGIS internal port (Web Adaptor -> Portal). */
  PORTAL: 7443,
  /** ArcGIS Server / Image Server internal port (Web Adaptor -> Server). */
  SERVER: 6443,
  /** Image Server alternative HTTPS port. */
  SERVER_ALT: 6143,
  /** Notebook Server server-side rendering (Portal -> Notebook). */
  NOTEBOOK_SSR: 11443,
  /** ArcGIS Data Store relational store access (ArcGIS Server -> Data Store). */
  DATASTORE_RELATIONAL: 2443,
  /** Enterprise Geodatabase / RDS PostgreSQL (registered SDE data). */
  POSTGRES: 5432,
  /** SMB - config store / file data store on FSx for Windows. */
  SMB: 445,
  /** SQL Server browser (used by ArcGIS Server, if applicable). */
  SQL_BROWSER: 1434,
} as const;

/** Inclusive TCP port ranges used by ArcGIS HA synchronisation/replication. */
export const PortRanges = {
  /** Portal HA state synchronisation between Portal nodes. */
  PORTAL_HA: { from: 5701, to: 5801 },
  /** ArcGIS Server / Image Server inter-node site replication. */
  SERVER_REPLICATION: { from: 4181, to: 4190 },
  /** Image Server inter-node replication. */
  IMAGE_REPLICATION: { from: 4181, to: 4182 },
  /** Data Store replication / tile-cache / webhook ports. */
  DATASTORE_REPLICATION: { from: 9820, to: 9850 },
  DATASTORE_WEBHOOKS: { from: 45671, to: 45672 },
  /** Notebook Server Docker container range (internal to the instance). */
  NOTEBOOK_DOCKER: { from: 30001, to: 31000 },
} as const;
