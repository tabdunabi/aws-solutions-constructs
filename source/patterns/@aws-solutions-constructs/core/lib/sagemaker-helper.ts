/**
 *  Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as sagemaker from '@aws-cdk/aws-sagemaker';
import * as ec2 from '@aws-cdk/aws-ec2';
import { buildEncryptionKey } from './kms-helper';
import {
  DefaultSagemakerNotebookProps,
  DefaultSagemakerModelProps,
  DefaultSagemakerEndpointConfigProps,
  DefaultSagemakerEndpointProps,
} from './sagemaker-defaults';
import * as cdk from '@aws-cdk/core';
import { overrideProps } from './utils';
import { buildVpc } from './vpc-helper';
import * as iam from '@aws-cdk/aws-iam';
import { Aws } from '@aws-cdk/core';

export interface BuildSagemakerNotebookProps {
  /**
   * Optional user provided props for CfnNotebookInstanceProps
   *
   * @default - Default props are used
   */
  readonly sagemakerNotebookProps?: sagemaker.CfnNotebookInstanceProps | any;
  /**
   * Optional user provided props to deploy inside vpc
   *
   * @default - true
   */
  readonly deployInsideVpc?: boolean;
  /**
   * An optional, Existing instance of notebook object.
   * If this is set then the sagemakerNotebookProps is ignored
   *
   * @default - None
   */
  readonly existingNotebookObj?: sagemaker.CfnNotebookInstance;
  /**
   * IAM Role Arn for SageMaker NoteBookInstance
   *
   * @default - None
   */
  readonly role: iam.Role;
}

function addPermissions(_role: iam.Role) {
  // Grant permissions to NoteBookInstance for creating and training the model
  _role.addToPolicy(
    new iam.PolicyStatement({
      resources: [`arn:${Aws.PARTITION}:sagemaker:${Aws.REGION}:${Aws.ACCOUNT_ID}:*`],
      actions: [
        'sagemaker:CreateTrainingJob',
        'sagemaker:DescribeTrainingJob',
        'sagemaker:CreateModel',
        'sagemaker:DescribeModel',
        'sagemaker:DeleteModel',
        'sagemaker:CreateEndpoint',
        'sagemaker:CreateEndpointConfig',
        'sagemaker:DescribeEndpoint',
        'sagemaker:DescribeEndpointConfig',
        'sagemaker:DeleteEndpoint',
        'sagemaker:DeleteEndpointConfig',
        'sagemaker:InvokeEndpoint',
      ],
    })
  );

  // Grant CloudWatch Logging permissions
  _role.addToPolicy(
    new iam.PolicyStatement({
      resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/sagemaker/*`],
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:DescribeLogStreams',
        'logs:GetLogEvents',
        'logs:PutLogEvents',
      ],
    })
  );

  // Grant GetRole permissions to the SageMaker service
  _role.addToPolicy(
    new iam.PolicyStatement({
      resources: [_role.roleArn],
      actions: ['iam:GetRole'],
    })
  );

  // Grant PassRole permissions to the SageMaker service
  _role.addToPolicy(
    new iam.PolicyStatement({
      resources: [_role.roleArn],
      actions: ['iam:PassRole'],
      conditions: {
        StringLike: { 'iam:PassedToService': 'sagemaker.amazonaws.com' },
      },
    })
  );
}

export function buildSagemakerNotebook(
  scope: cdk.Construct,
  props: BuildSagemakerNotebookProps
): [sagemaker.CfnNotebookInstance, ec2.Vpc?, ec2.SecurityGroup?] {
  // Setup the notebook properties
  let sagemakerNotebookProps;
  let vpcInstance;
  let securityGroup;
  let kmsKeyId: string;
  let subnetId: string;

  // Conditional Sagemaker Notebook creation
  if (!props.existingNotebookObj) {
    if (
      (props.sagemakerNotebookProps?.subnetId && props.sagemakerNotebookProps?.securityGroupIds === undefined) ||
      (props.sagemakerNotebookProps?.subnetId === undefined && props.sagemakerNotebookProps?.securityGroupIds)
    ) {
      throw new Error('Must define both sagemakerNotebookProps.subnetId and sagemakerNotebookProps.securityGroupIds');
    }

    addPermissions(props.role);

    if (props.sagemakerNotebookProps?.kmsKeyId === undefined) {
      kmsKeyId = buildEncryptionKey(scope).keyId;
    } else {
      kmsKeyId = props.sagemakerNotebookProps.kmsKeyId;
    }

    if (props.deployInsideVpc === undefined || props.deployInsideVpc) {
      if (
        props.sagemakerNotebookProps?.subnetId === undefined &&
        props.sagemakerNotebookProps?.securityGroupIds === undefined
      ) {
        vpcInstance = buildVpc(scope);
        securityGroup = new ec2.SecurityGroup(scope, 'SecurityGroup', {
          vpc: vpcInstance,
          allowAllOutbound: false,
        });
        securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

        // Add Cfn_Nag Suppression for WARN W5: Security Groups found with cidr open to world on egress
        const cfnSecurityGroup = securityGroup.node.findChild('Resource') as ec2.CfnSecurityGroup;
        cfnSecurityGroup.cfnOptions.metadata = {
          cfn_nag: {
            rules_to_suppress: [
              {
                id: 'W5',
                reason: 'Allow notebook users to access the Internet from the notebook',
              },
            ],
          },
        };

        subnetId = vpcInstance.privateSubnets[0].subnetId;

        sagemakerNotebookProps = DefaultSagemakerNotebookProps(props.role.roleArn, kmsKeyId, subnetId, [
          securityGroup.securityGroupId,
        ]);
      } else {
        sagemakerNotebookProps = DefaultSagemakerNotebookProps(
          props.role.roleArn,
          kmsKeyId,
          props.sagemakerNotebookProps?.subnetId,
          props.sagemakerNotebookProps?.securityGroupIds
        );
      }
    } else {
      sagemakerNotebookProps = DefaultSagemakerNotebookProps(props.role.roleArn, kmsKeyId);
    }

    if (props.sagemakerNotebookProps) {
      sagemakerNotebookProps = overrideProps(sagemakerNotebookProps, props.sagemakerNotebookProps);
    }

    // Create the notebook
    const sagemakerInstance: sagemaker.CfnNotebookInstance = new sagemaker.CfnNotebookInstance(
      scope,
      'SagemakerNotebook',
      sagemakerNotebookProps
    );
    if (vpcInstance) {
      return [sagemakerInstance, vpcInstance, securityGroup];
    } else {
      return [sagemakerInstance];
    }
  } else {
    // Return existing notebook object
    return [props.existingNotebookObj];
  }
}

export interface BuildSageMakerEndpointProps {
  /**
   * Existing SageMaker Enpoint object, if this is set then the modelProps, endpointConfigProps, and endpointProps are ignored
   *
   * @default - None
   */
  readonly existingSageMakerEndpointObj?: sagemaker.CfnEndpoint;
  /**
   * User provided props to create SageMaker Model
   *
   * @default - None
   */
  readonly modelProps?: sagemaker.CfnModelProps;
  /**
   * User provided props to create SageMaker Endpoint Configuration
   *
   * @default - None
   */
  readonly endpointConfigProps?: sagemaker.CfnEndpointConfigProps;
  /**
   * User provided props to create SageMaker Endpoint
   *
   * @default - None
   */
  readonly endpointProps?: sagemaker.CfnEndpointProps;
  /**
   * A VPC where the SageMaker Endpoint will be placed
   *
   * @default - None
   */
  readonly vpc?: ec2.Vpc;
  /**
   * Whether to deploy a natgatway in the new VPC (if deployVpc is true).
   * If deployNatGateway is true, the construct creates Public and Private subnets.
   * Otherwise, it creates Isolated subnets only
   *
   * @default - false
   */
  readonly deployNatGateway?: boolean;
  /**
   * IAM Rol, with all required permissions, to be assumed by SageMaker to create resources
   * The Role is not required if existingSageMakerEndpointObj is provided.
   *
   * @default - None
   */
  readonly role?: iam.Role;
}

export function BuildSageMakerEndpoint(
  scope: cdk.Construct,
  props: BuildSageMakerEndpointProps
): [sagemaker.CfnEndpoint, sagemaker.CfnEndpointConfig?, sagemaker.CfnModel?] {
  /** Conditional SageMaker endpoint creation */
  if (!props.existingSageMakerEndpointObj) {
    if (props.modelProps) {
      /** return [endpoint, endpointConfig, model] */
      return deploySagemakerEndpoint(scope, props);
    } else {
      throw Error('Either existingSageMakerEndpointObj or at least modelProps is required');
    }
  } else {
    /** Otherwise, return [endpoint] */
    return [props.existingSageMakerEndpointObj];
  }
}

export function deploySagemakerEndpoint(
  scope: cdk.Construct,
  props: BuildSageMakerEndpointProps
): [sagemaker.CfnEndpoint, sagemaker.CfnEndpointConfig?, sagemaker.CfnModel?] {
  let model: sagemaker.CfnModel;
  let endpointConfig: sagemaker.CfnEndpointConfig;
  let endpoint: sagemaker.CfnEndpoint;

  // Create SageMaker's model, endpointConfig, and endpoint
  if (props.modelProps && props.role) {
    model = createSagemakerModel(scope, props.modelProps, props.role, props.vpc, props.deployNatGateway);
    // Create SageMake EndpointConfig
    endpointConfig = createSagemakerEndpointConfig(scope, model.attrModelName, props.endpointConfigProps);
    // Add dependency on model
    endpointConfig.addDependsOn(model);
    // Create SageMaker Endpoint
    endpoint = createSagemakerEndpoint(scope, endpointConfig.attrEndpointConfigName, props.endpointProps);
    // Add dependency on EndpointConfig
    endpoint.addDependsOn(endpointConfig);

    return [endpoint, endpointConfig, model];
  } else {
    throw Error('You need to provide at least modelProps and SageMaker IAM Role to create Sagemaker Endpoint');
  }
}

export function createSagemakerModel(
  scope: cdk.Construct,
  modelProps: sagemaker.CfnModelProps,
  role: iam.Role,
  vpc?: ec2.Vpc,
  deployNatGateway?: boolean
): sagemaker.CfnModel {
  let finalModelProps: sagemaker.CfnModelProps;
  let primaryContainer: sagemaker.CfnModel.ContainerDefinitionProperty;
  let vpcConfig: sagemaker.CfnModel.VpcConfigProperty | undefined;
  let model: sagemaker.CfnModel;

  if (vpc) {
    const modelDefaultSecurityGroup = new ec2.SecurityGroup(scope, 'ReplaceModelDefaultSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    // Allow https traffic from within the VPC
    modelDefaultSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443));

    const cfnSecurityGroup = modelDefaultSecurityGroup.node.findChild('Resource') as ec2.CfnSecurityGroup;
    cfnSecurityGroup.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W5',
            reason: 'Egress of 0.0.0.0/0 is default and generally considered OK',
          },
          {
            id: 'W40',
            reason: 'Egress IPProtocol of -1 is default and generally considered OK',
          },
        ],
      },
    };

    // Get the subnetIds and securityGroup
    vpcConfig = {
      subnets: vpc.selectSubnets({
        // if deployNatGateway is false and vpc contains isolated subnets, select isolated. Otherwise, select private subnets
        subnetType: !deployNatGateway && vpc.isolatedSubnets ? ec2.SubnetType.ISOLATED : ec2.SubnetType.PRIVATE,
        onePerAz: true,
      }).subnetIds,
      securityGroupIds: [modelDefaultSecurityGroup.securityGroupId],
    };
  }
  if (modelProps.primaryContainer) {
    // Get user provided Model's primary container
    primaryContainer = modelProps.primaryContainer as sagemaker.CfnModel.ContainerDefinitionProperty;
    // Get default Model props
    finalModelProps = DefaultSagemakerModelProps(modelProps.executionRoleArn, primaryContainer, vpcConfig);
    // Overwrite default model properties
    finalModelProps = overrideProps(finalModelProps, modelProps);

    // Create the SageMaker's Model
    model = new sagemaker.CfnModel(scope, 'SageMakerModel', finalModelProps);
    // Add dependency on the SageMaker's role
    model.node.addDependency(role);

    return model;
  } else {
    throw Error('You need to provide at least primnaryContainer to create Sagemaker Model');
  }
}

export function createSagemakerEndpointConfig(
  scope: cdk.Construct,
  modelName: string,
  endpointConfigProps?: sagemaker.CfnEndpointConfigProps
): sagemaker.CfnEndpointConfig {
  let finalEndpointConfigProps: sagemaker.CfnEndpointConfigProps;
  let kmsKeyId: string;
  let endpointConfig: sagemaker.CfnEndpointConfig;

  // Create encryption key if one is not provided
  if (endpointConfigProps && endpointConfigProps.kmsKeyId) {
    kmsKeyId = endpointConfigProps.kmsKeyId;
  } else {
    kmsKeyId = buildEncryptionKey(scope).keyId;
  }
  // Get default EndpointConfig props
  finalEndpointConfigProps = DefaultSagemakerEndpointConfigProps(modelName, kmsKeyId);
  // Overwrite default EndpointConfig properties
  if (endpointConfigProps) {
    finalEndpointConfigProps = overrideProps(finalEndpointConfigProps, endpointConfigProps);
  }

  // Create the SageMaker's EndpointConfig
  endpointConfig = new sagemaker.CfnEndpointConfig(scope, 'SageMakerEndpointConfig', finalEndpointConfigProps);

  return endpointConfig;
}

export function createSagemakerEndpoint(
  scope: cdk.Construct,
  endpointConfigName: string,
  endpointProps?: sagemaker.CfnEndpointProps
): sagemaker.CfnEndpoint {
  let finalEndpointProps: sagemaker.CfnEndpointProps;
  let endpoint: sagemaker.CfnEndpoint;

  // Get default Endpoint props
  finalEndpointProps = DefaultSagemakerEndpointProps(endpointConfigName);
  // Overwrite default Endpoint properties
  if (endpointProps) {
    finalEndpointProps = overrideProps(finalEndpointProps, endpointProps);
  }

  // Create the SageMaker's Endpoint
  endpoint = new sagemaker.CfnEndpoint(scope, 'SageMakerEndpoint', finalEndpointProps);

  return endpoint;
}