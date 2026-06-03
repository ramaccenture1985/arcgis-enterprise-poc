import { Stack, StackProps, Tags, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { EnvironmentConfig } from '../config/environments';
import { EsriVpc } from '../constructs/esri-vpc';
import { SecurityGroups } from '../constructs/security-groups';
import { Ports } from '../config/ports';

export interface LoadBalancerStackProps extends StackProps {
  readonly envConfig: EnvironmentConfig;
  readonly esriVpc: EsriVpc;
  readonly securityGroups: SecurityGroups;
  readonly accessLogsBucket: s3.IBucket;
  /** Portal Web Adaptor instances to register to the Public ALB target group. */
  readonly portalWebAdaptors: ec2.Instance[];
  /** ArcGIS Server Web Adaptor instances (Internal ALB + Private NLB). */
  readonly agsWebAdaptors: ec2.Instance[];
  /** Image Server Web Adaptor instances (Internal ALB image path). */
  readonly imageWebAdaptors: ec2.Instance[];
}

/**
 * LoadBalancerStack provisions the ingress and load-balancing tier (LLD section 8):
 *   - Public ALB (internet-facing) + AWS WAF web ACL + ACM certificate
 *   - Internal ALB (federation / private application access)
 *   - Private NLB (API Gateway -> ArcGIS Server path)
 *   - Target groups with the section 8.4 health-check baseline
 *
 * Instances are registered to these target groups by the ComputeStack.
 */
export class LoadBalancerStack extends Stack {
  public readonly publicAlb: elbv2.ApplicationLoadBalancer;
  public readonly internalAlb: elbv2.ApplicationLoadBalancer;
  public readonly privateNlb: elbv2.NetworkLoadBalancer;

  public readonly portalWaTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly agsWaTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly imageWaTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly nlbTargetGroup: elbv2.NetworkTargetGroup;

  constructor(scope: Construct, id: string, props: LoadBalancerStackProps) {
    super(scope, id, props);
    const env = props.envConfig;
    const v = props.esriVpc;
    const sg = props.securityGroups;

    // ACM certificate (LLD 8.5). A single approved wildcard certificate covers
    // both listeners per 8.5.1. publicDomain is a placeholder to be replaced
    // with the approved XYZ domain; DNS validation completes against that zone.
    const publicDomain = env.publicDomain ?? `${env.name}.xyz-agotest-platform.gov.au`;
    const certificate = new acm.Certificate(this, 'WildcardCertificate', {
      domainName: `*.${publicDomain}`,
      subjectAlternativeNames: [publicDomain],
      validation: acm.CertificateValidation.fromDns(),
    });

    // Section 8.4 health-check baseline (HTTPS, 200, 3/3 thresholds, 30s/5s).
    const albHealthCheck: elbv2.HealthCheck = {
      protocol: elbv2.Protocol.HTTPS,
      path: '/',
      healthyHttpCodes: '200,302',
      healthyThresholdCount: 3,
      unhealthyThresholdCount: 3,
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
    };

    // --- Public ALB (Table 32 / 34) ---
    this.publicAlb = new elbv2.ApplicationLoadBalancer(this, 'PublicAlb', {
      loadBalancerName: `${env.name}-alb-esri-public`,
      vpc: v.vpc,
      internetFacing: true,
      securityGroup: sg.sg('sg-alb-public'),
      vpcSubnets: { subnets: v.subnetsFor(['public-alb-az-a', 'public-alb-az-b']) },
      deletionProtection: env.deletionProtection,
      idleTimeout: Duration.seconds(60),
    });
    this.publicAlb.logAccessLogs(props.accessLogsBucket, `${env.name}/alb-public`);

    this.portalWaTargetGroup = new elbv2.ApplicationTargetGroup(this, 'TgPortalWa', {
      targetGroupName: `${env.name}-tg-portal-wa`,
      vpc: v.vpc,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      port: Ports.HTTPS,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: albHealthCheck,
      deregistrationDelay: Duration.seconds(60),
      targets: props.portalWebAdaptors.map((i) => new targets.InstanceTarget(i, Ports.HTTPS)),
    });

    this.publicAlb.addListener('PublicHttps', {
      port: Ports.HTTPS,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
      defaultTargetGroups: [this.portalWaTargetGroup],
    });
    // Optional HTTP -> HTTPS redirect (Table 34).
    this.publicAlb.addListener('PublicHttpRedirect', {
      port: Ports.HTTP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
    });

    // --- Internal ALB (Table 33 / 35) ---
    this.internalAlb = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
      loadBalancerName: `${env.name}-alb-esri-internal`,
      vpc: v.vpc,
      internetFacing: false,
      securityGroup: sg.sg('sg-alb-internal'),
      vpcSubnets: { subnets: v.subnetsFor(['private-internal-az-a', 'private-internal-az-b']) },
      deletionProtection: env.deletionProtection,
      idleTimeout: Duration.seconds(60),
    });
    this.internalAlb.logAccessLogs(props.accessLogsBucket, `${env.name}/alb-internal`);

    this.agsWaTargetGroup = new elbv2.ApplicationTargetGroup(this, 'TgAgsWa', {
      targetGroupName: `${env.name}-tg-ags-wa`,
      vpc: v.vpc,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      port: Ports.HTTPS,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: albHealthCheck,
      deregistrationDelay: Duration.seconds(60),
      targets: props.agsWebAdaptors.map((i) => new targets.InstanceTarget(i, Ports.HTTPS)),
    });
    this.imageWaTargetGroup = new elbv2.ApplicationTargetGroup(this, 'TgImageWa', {
      targetGroupName: `${env.name}-tg-image-wa`,
      vpc: v.vpc,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      port: Ports.HTTPS,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: albHealthCheck,
      deregistrationDelay: Duration.seconds(60),
      targets: props.imageWebAdaptors.map((i) => new targets.InstanceTarget(i, Ports.HTTPS)),
    });

    const internalListener = this.internalAlb.addListener('InternalHttps', {
      port: Ports.HTTPS,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
      defaultTargetGroups: [this.agsWaTargetGroup],
    });
    // Image Server Web Adaptor path (4.2.3/4.2.4 - Image is portal-originated via Internal ALB).
    internalListener.addAction('ImagePath', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/image/*', '/arcgis/image/*'])],
      action: elbv2.ListenerAction.forward([this.imageWaTargetGroup]),
    });

    // --- Private NLB (Table 36 / 40) ---
    this.privateNlb = new elbv2.NetworkLoadBalancer(this, 'PrivateNlb', {
      loadBalancerName: `${env.name}-nlb-esri-private`,
      vpc: v.vpc,
      internetFacing: false,
      vpcSubnets: { subnets: v.subnetsFor(['private-nlb-az-a']) },
      securityGroups: [sg.sg('sg-nlb')],
      deletionProtection: env.deletionProtection,
    });

    this.nlbTargetGroup = new elbv2.NetworkTargetGroup(this, 'TgNlb', {
      targetGroupName: `${env.name}-tg-nlb`,
      vpc: v.vpc,
      protocol: elbv2.Protocol.TCP,
      port: Ports.HTTPS,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        protocol: elbv2.Protocol.HTTPS,
        path: '/',
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        interval: Duration.seconds(30),
      },
      deregistrationDelay: Duration.seconds(60),
      targets: props.agsWebAdaptors.map((i) => new targets.InstanceTarget(i, Ports.HTTPS)),
    });
    this.privateNlb.addListener('NlbTls', {
      port: Ports.HTTPS,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [this.nlbTargetGroup],
    });

    // --- AWS WAF web ACL on the Public ALB (Tables 43 / 44) ---
    this.createWebAcl(env, this.publicAlb);

    Tags.of(this).add('Environment', env.name);
    Tags.of(this).add('Workload', 'arcgis-enterprise');
    Tags.of(this).add('Component', 'ingress');
  }

  private createWebAcl(env: EnvironmentConfig, alb: elbv2.ApplicationLoadBalancer): void {
    const managed = (
      name: string,
      priority: number,
      ruleName: string,
    ): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: { vendorName: 'AWS', name: ruleName },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: name,
      },
    });

    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      managed('CommonRuleSet', 1, 'AWSManagedRulesCommonRuleSet'),
      managed('KnownBadInputs', 2, 'AWSManagedRulesKnownBadInputsRuleSet'),
      managed('SQLi', 3, 'AWSManagedRulesSQLiRuleSet'),
      managed('AmazonIpReputation', 4, 'AWSManagedRulesAmazonIpReputationList'),
      managed('AnonymousIpList', 5, 'AWSManagedRulesAnonymousIpList'),
      {
        name: 'RateLimit',
        priority: 6,
        action: { block: {} },
        statement: {
          rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' },
        },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'RateLimit',
        },
      },
    ];

    const webAcl = new wafv2.CfnWebACL(this, 'PublicWebAcl', {
      name: `${env.name}-waf-esri-public-alb`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${env.name}-waf-esri-public-alb`,
      },
      rules,
    });

    new wafv2.CfnWebACLAssociation(this, 'PublicWebAclAssociation', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });
  }
}
