#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS, getEnvironment, EnvName } from '../lib/config/environments';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { LoadBalancerStack } from '../lib/stacks/load-balancer-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';
import { ConnectivityTestStack } from '../lib/stacks/connectivity-test-stack';

const app = new cdk.App();

/**
 * Select which environment(s) to synthesise.
 *   cdk synth -c env=prod      -> just prod
 *   cdk synth -c env=all       -> every environment (default)
 *
 * Each environment is deployed to its own application account (HLD section 4.1).
 * Account ids are taken from context (e.g. -c account_prod=1234...) or the
 * CDK_DEFAULT_ACCOUNT for the active credentials.
 */
const envArg = (app.node.tryGetContext('env') as string | undefined) ?? 'all';
const selected: EnvName[] =
  envArg === 'all' ? (Object.keys(ENVIRONMENTS) as EnvName[]) : [getEnvironment(envArg).name];

for (const name of selected) {
  const cfg = getEnvironment(name);
  const account =
    (app.node.tryGetContext(`account_${name}`) as string | undefined) ??
    cfg.account ??
    process.env.CDK_DEFAULT_ACCOUNT;
  const cdkEnv: cdk.Environment = { account, region: cfg.region };

  const prefix = `Xyz-Esri-${cfg.name}`;

  const network = new NetworkStack(app, `${prefix}-Network`, {
    env: cdkEnv,
    envConfig: cfg,
    description: `ArcGIS Enterprise network (${cfg.name})`,
  });

  const security = new SecurityStack(app, `${prefix}-Security`, {
    env: cdkEnv,
    envConfig: cfg,
    description: `ArcGIS Enterprise security/identity (${cfg.name})`,
  });

  const data = new DataStack(app, `${prefix}-Data`, {
    env: cdkEnv,
    envConfig: cfg,
    esriVpc: network.esriVpc,
    securityGroups: network.securityGroups,
    kmsKey: security.kmsKey,
    description: `ArcGIS Enterprise data tier (${cfg.name})`,
  });
  data.addDependency(network);
  data.addDependency(security);

  const compute = new ComputeStack(app, `${prefix}-Compute`, {
    env: cdkEnv,
    envConfig: cfg,
    esriVpc: network.esriVpc,
    securityGroups: network.securityGroups,
    roles: security.roles,
    kmsKey: security.kmsKey,
    description: `ArcGIS Enterprise compute (${cfg.name})`,
  });
  compute.addDependency(network);
  compute.addDependency(security);

  // The load-balancer stack registers the Web Adaptor instances into its target
  // groups, so it is created after compute (avoids a cross-stack cycle).
  const loadBalancers = new LoadBalancerStack(app, `${prefix}-LoadBalancers`, {
    env: cdkEnv,
    envConfig: cfg,
    esriVpc: network.esriVpc,
    securityGroups: network.securityGroups,
    accessLogsBucket: data.accessLogsBucket,
    portalWebAdaptors: compute.portalWebAdaptors,
    agsWebAdaptors: compute.agsWebAdaptors,
    imageWebAdaptors: compute.imageWebAdaptors,
    description: `ArcGIS Enterprise ingress/load balancing (${cfg.name})`,
  });
  loadBalancers.addDependency(network);
  loadBalancers.addDependency(data);
  loadBalancers.addDependency(compute);

  const connectivity = new ConnectivityTestStack(app, `${prefix}-ConnectivityTest`, {
    env: cdkEnv,
    envConfig: cfg,
    esriVpc: network.esriVpc,
    securityGroups: network.securityGroups,
    publicAlbDns: loadBalancers.publicAlb.loadBalancerDnsName,
    internalAlbDns: loadBalancers.internalAlb.loadBalancerDnsName,
    nlbDns: loadBalancers.privateNlb.loadBalancerDnsName,
    rdsEndpoint: data.database.dbInstanceEndpointAddress,
    rdsReplicaEndpoint: data.readReplica?.dbInstanceEndpointAddress,
    description: `ArcGIS Enterprise connectivity tests (${cfg.name})`,
  });
  connectivity.addDependency(network);
  connectivity.addDependency(data);
  connectivity.addDependency(loadBalancers);
}

app.synth();
