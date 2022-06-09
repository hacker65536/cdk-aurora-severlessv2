import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { aws_rds as rds } from "aws-cdk-lib";
import { aws_iam as iam } from "aws-cdk-lib";
import { aws_ec2 as ec2 } from "aws-cdk-lib";
import { aws_autoscaling as autoscaling } from "aws-cdk-lib";
import { custom_resources as cr } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Port } from "aws-cdk-lib/aws-ec2";

export class CdkAuroraSeverlessv2Stack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ref https://github.com/aws/aws-cdk/issues/20197#issuecomment-1117555047
    /*
    1. create a dbcluster
    2. create a first dbinstance of provisioned
    3. modify ServerlessV2ScalingConfiguration to dbcluster
    4. create a second dbinstance of serverlessv2
    5. create a asg for loadtest
    6. allow access from asg to rds


    */

    enum ServerlessInstanceType {
      SERVERLESS = "serverless",
    }

    type CustomInstanceType = ServerlessInstanceType | ec2.InstanceType;

    const CustomInstanceType = {
      ...ServerlessInstanceType,
      ...ec2.InstanceType,
    };

    const dbClusterInstanceCount: number = 1;

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
    });

    const dbCluster = new rds.DatabaseCluster(this, "AuroraServerlessv2", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_02_0,
      }),
      instances: dbClusterInstanceCount,
      instanceProps: { vpc },
      monitoringInterval: cdk.Duration.seconds(10),
    });

    const serverlessV2ScalingConfiguration = {
      MinCapacity: 0.5,
      MaxCapacity: 16,
    };

    const dbScalingConfigure = new cr.AwsCustomResource(
      this,
      "DbScalingConfigure",
      {
        onCreate: {
          service: "RDS",
          action: "modifyDBCluster",
          parameters: {
            DBClusterIdentifier: dbCluster.clusterIdentifier,
            ServerlessV2ScalingConfiguration: serverlessV2ScalingConfiguration,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            dbCluster.clusterIdentifier
          ),
        },
        onUpdate: {
          service: "RDS",
          action: "modifyDBCluster",
          parameters: {
            DBClusterIdentifier: dbCluster.clusterIdentifier,
            ServerlessV2ScalingConfiguration: serverlessV2ScalingConfiguration,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            dbCluster.clusterIdentifier
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      }
    );

    const cfnDbCluster = dbCluster.node.defaultChild as rds.CfnDBCluster;
    const dbScalingConfigureTarget = dbScalingConfigure.node.findChild(
      "Resource"
    ).node.defaultChild as cdk.CfnResource;

    cfnDbCluster.addPropertyOverride("EngineMode", "provisioned");
    dbScalingConfigure.node.addDependency(cfnDbCluster);

    dbScalingConfigureTarget.node.addDependency(
      dbCluster.node.findChild(`Instance1`) as rds.CfnDBInstance
    );

    const serverlessDBinstance = new rds.CfnDBInstance(
      this,
      "ServerlessInstance",
      {
        dbClusterIdentifier: dbCluster.clusterIdentifier,
        dbInstanceClass: "db.serverless",
        engine: "aurora-mysql",
        engineVersion: "8.0.mysql_aurora.3.02.0",
        monitoringInterval: 10,
        monitoringRoleArn: (
          dbCluster.node.findChild("MonitoringRole") as iam.Role
        ).roleArn,
        enablePerformanceInsights: true,
      }
    );

    serverlessDBinstance.node.addDependency(dbScalingConfigureTarget);

    const userdata = ec2.UserData.forLinux({
      shebang: "#!/bin/env bash",
    });
    const userdatacmd = [
      "yum update -y",
      "yum install -y jq git make automake libtool pkgconfig libaio-devel",
      "yum install -y mysql-devel openssl-devel",
      "yum install -y postgresql-devel",
      "cd /usr/local/src",
      "git clone https://github.com/akopytov/sysbench.git",
      "cd sysbench/",
      "./autogen.sh",
      "./configure",
      "make -j",
      "make install",
      "rpm --import https://repo.mysql.com/RPM-GPG-KEY-mysql-2022",
      "yum -y install https://dev.mysql.com/get/mysql80-community-release-el7-6.noarch.rpm",
      "yum install mysql -y",
      "sysbench --version",
    ];
    userdata.addCommands(...userdatacmd);

    const loadtestasg = new autoscaling.AutoScalingGroup(this, "ASG", {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.C6A,
        ec2.InstanceSize.LARGE
      ),
      userData: userdata,
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
        storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE,
      }),
      desiredCapacity: 2,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: autoscaling.BlockDeviceVolume.ebs(16, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      updatePolicy: autoscaling.UpdatePolicy.replacingUpdate(),
    });

    const policies: string[] = [
      "AmazonSSMManagedInstanceCore",
      "SecretsManagerReadWrite",
    ];

    for (let v of policies) {
      loadtestasg.role.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName(v)
      );
    }

    dbCluster.connections.allowFrom(loadtestasg, Port.tcp(3306));

    new CfnOutput(this, "rdspass", {
      value: dbCluster.secret?.secretArn!,
    });
  }
}
