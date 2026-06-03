import { Stack, StackProps, Tags, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { EnvironmentConfig } from '../config/environments';
import { EsriVpc } from '../constructs/esri-vpc';
import { SecurityGroups } from '../constructs/security-groups';

export interface ConnectivityTestStackProps extends StackProps {
  readonly envConfig: EnvironmentConfig;
  readonly esriVpc: EsriVpc;
  readonly securityGroups: SecurityGroups;
  readonly publicAlbDns: string;
  readonly internalAlbDns: string;
  readonly nlbDns: string;
  readonly rdsEndpoint: string;
  readonly rdsReplicaEndpoint?: string;
}

interface Target {
  name: string;
  host: string;
  port: number;
}

/**
 * ConnectivityTestStack deploys a VPC-attached Lambda that probes TCP
 * reachability to the key endpoints across the environment - the three load
 * balancers, the RDS PostgreSQL endpoints, and the AWS service endpoints
 * (S3 gateway + Secrets Manager / SSM interface endpoints). It validates that
 * the routing, security-group matrix and VPC endpoints actually permit the
 * intended flows.
 *
 * Run it on demand:
 *   aws lambda invoke --function-name <name> --payload '{}' out.json && cat out.json
 *
 * The Lambda runs in the private-services subnets using sg-conntest, whose
 * egress + the matching target ingress rules are defined in the security-group
 * matrix.
 */
export class ConnectivityTestStack extends Stack {
  constructor(scope: Construct, id: string, props: ConnectivityTestStackProps) {
    super(scope, id, props);
    const env = props.envConfig;
    const region = env.region;

    const targets: Target[] = [
      { name: 'public-alb', host: props.publicAlbDns, port: 443 },
      { name: 'internal-alb', host: props.internalAlbDns, port: 443 },
      { name: 'private-nlb', host: props.nlbDns, port: 443 },
      { name: 'rds-postgres', host: props.rdsEndpoint, port: 5432 },
      // VPC endpoint validation (resolve to private ENIs / gateway):
      { name: 'vpce-secretsmanager', host: `secretsmanager.${region}.amazonaws.com`, port: 443 },
      { name: 'vpce-ssm', host: `ssm.${region}.amazonaws.com`, port: 443 },
      { name: 'gateway-s3', host: `s3.${region}.amazonaws.com`, port: 443 },
    ];
    if (props.rdsReplicaEndpoint) {
      targets.push({ name: 'rds-read-replica', host: props.rdsReplicaEndpoint, port: 5432 });
    }

    const fn = new lambda.Function(this, 'ConnectivityTest', {
      functionName: `${env.name}-esri-connectivity-test`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: Duration.seconds(60),
      memorySize: 256,
      vpc: props.esriVpc.vpc,
      vpcSubnets: {
        subnets: props.esriVpc.subnetsFor(['private-services-az-a', 'private-services-az-b']),
      },
      securityGroups: [props.securityGroups.sg('sg-conntest')],
      environment: {
        TARGETS: JSON.stringify(targets),
        ENVIRONMENT: env.name,
      },
      code: lambda.Code.fromInline(LAMBDA_SRC),
    });

    new CfnOutput(this, 'ConnectivityTestFunctionName', {
      value: fn.functionName,
      description: 'Invoke to run cross-environment connectivity tests',
    });

    Tags.of(this).add('Environment', env.name);
    Tags.of(this).add('Workload', 'arcgis-enterprise');
    Tags.of(this).add('Component', 'connectivity-test');
  }
}

/**
 * Inline Lambda source (Python, stdlib only). Attempts a TCP connect to each
 * target and reports pass/fail + latency. Accepts an optional {"targets":[...]}
 * payload to override the configured list.
 */
const LAMBDA_SRC = `
import os, socket, json, time

def _probe(t):
    host = t["host"]; port = int(t["port"]); name = t.get("name", host)
    timeout = float(t.get("timeout", 5))
    start = time.time()
    ok = False; err = None
    try:
        with socket.create_connection((host, port), timeout=timeout):
            ok = True
    except Exception as e:  # noqa: BLE001
        err = str(e)
    return {
        "name": name, "host": host, "port": port, "ok": ok,
        "latency_ms": round((time.time() - start) * 1000, 1), "error": err,
    }

def handler(event, context):
    targets = json.loads(os.environ.get("TARGETS", "[]"))
    if isinstance(event, dict) and event.get("targets"):
        targets = event["targets"]
    results = [_probe(t) for t in targets]
    summary = {
        "environment": os.environ.get("ENVIRONMENT"),
        "passed": sum(1 for r in results if r["ok"]),
        "failed": sum(1 for r in results if not r["ok"]),
        "total": len(results),
        "results": results,
    }
    print(json.dumps(summary))
    return summary
`;
