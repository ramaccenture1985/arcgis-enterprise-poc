import { Construct } from 'constructs';
import { Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * ArcgisInstance is a thin wrapper over ec2.Instance that applies the deployment
 * standards from the LLD compute design (section 6):
 *   - Windows Server 2022 base AMI (6.2)
 *   - gp3 root volume, encrypted at rest with the per-env CMK (7.2.1 / 9.5)
 *   - IMDSv2 required (hardening, section 5.3 / 9)
 *   - explicit subnet placement, security group and IAM role
 */
export interface ArcgisInstanceProps {
  readonly vpc: ec2.IVpc;
  readonly subnet: ec2.ISubnet;
  readonly instanceType: ec2.InstanceType;
  readonly securityGroup: ec2.ISecurityGroup;
  readonly role: iam.IRole;
  readonly nameTag: string;
  /** Root volume size in GiB (default 100). */
  readonly rootVolumeGib?: number;
  readonly machineImage?: ec2.IMachineImage;
  /**
   * EC2 key pair. Attaching one lets an operator retrieve and decrypt the
   * Windows local Administrator password (EC2 console "Get Windows password"),
   * which is needed for an interactive RDP session to run ArcGIS installers.
   */
  readonly keyPair?: ec2.IKeyPair;
  /** Customer-managed KMS key for root-volume encryption (LLD 9.5). */
  readonly kmsKey?: kms.IKey;
  /**
   * Keep the root volume when the instance is terminated. Set true for stateful
   * nodes (e.g. ArcGIS Data Store) whose data lives on the attached EBS volume.
   */
  readonly preserveRootVolume?: boolean;
  /** Optional extra user-data commands (appended after the RDP-enable step). */
  readonly extraUserData?: string[];
}

export class ArcgisInstance extends Construct {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: ArcgisInstanceProps) {
    super(scope, id);

    const machineImage = props.machineImage ?? ec2.MachineImage.latestWindows(
      ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE,
    );

    // Windows bootstrap: ensure Remote Desktop is enabled and allowed through
    // the host firewall so an operator can RDP in (via SSM port-forward or the
    // Bastion) to run ArcGIS installers. The SSM and CloudWatch agents ship
    // pre-installed on the AWS Windows Server 2022 AMI.
    const userData = ec2.UserData.forWindows();
    userData.addCommands(
      "Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name 'fDenyTSConnections' -Value 0",
      "Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'",
    );
    if (props.extraUserData?.length) {
      userData.addCommands(...props.extraUserData);
    }

    // Use a unique construct id (the env-prefixed name) for the instance: with
    // requireImdsv2, CDK derives the IMDSv2 launch-template name from this id,
    // and references it by name. A fixed id ("Instance") makes every launch
    // template request the same name and collide; the env-prefixed nameTag keeps
    // both the template and the instance's reference unique and consistent.
    this.instance = new ec2.Instance(this, props.nameTag, {
      vpc: props.vpc,
      vpcSubnets: { subnets: [props.subnet] },
      instanceType: props.instanceType,
      machineImage,
      securityGroup: props.securityGroup,
      role: props.role,
      keyPair: props.keyPair,
      userData,
      requireImdsv2: true,
      detailedMonitoring: true,
      blockDevices: [
        {
          deviceName: '/dev/sda1', // Windows AMI root device
          volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeGib ?? 100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            kmsKey: props.kmsKey,
            deleteOnTermination: props.preserveRootVolume ? false : true,
          }),
        },
      ],
    });

    Tags.of(this.instance).add('Name', props.nameTag);
  }
}
