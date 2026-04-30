import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';

export class SchoolbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3 Transcript Bucket ─────────────────────────────────────────────────
    const transcriptBucket = new s3.Bucket(this, 'TranscriptBucket', {
      bucketName: `schoolbot-transcripts-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // ── DynamoDB Tables ──────────────────────────────────────────────────────
    const districtsTable = new dynamodb.Table(this, 'DistrictsTable', {
      tableName: 'schoolbot-districts',
      partitionKey: { name: 'districtId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const transcriptsTable = new dynamodb.Table(this, 'TranscriptsTable', {
      tableName: 'schoolbot-transcripts',
      partitionKey: { name: 'districtId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'videoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const queryLogsTable = new dynamodb.Table(this, 'QueryLogsTable', {
      tableName: 'schoolbot-query-logs',
      partitionKey: { name: 'logId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── S3 Vector Store (vector bucket + index for Bedrock KB) ───────────────
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `schoolbot-vectors-${this.account}-${this.region}`,
    });

    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: vectorBucket.vectorBucketName!,
      indexName: 'schoolbot-index-v3',
      dataType: 'float32',
      dimension: 1024,
      distanceMetric: 'cosine',
      metadataConfiguration: {
        nonFilterableMetadataKeys: [
          'AMAZON_BEDROCK_TEXT',
          'AMAZON_BEDROCK_METADATA',
          'x-amz-bedrock-kb-chunk-id',
          'x-amz-bedrock-kb-data-source-id',
          'x-amz-bedrock-kb-source-uri',
          'x-amz-bedrock-kb-document-page-number',
        ],
      },
    });
    vectorIndex.addDependency(vectorBucket);

    // ── Bedrock Knowledge Base IAM Service Role ───────────────────────────────
    const kbRole = new iam.Role(this, 'BedrockKBRole', {
      roleName: 'schoolbot-bedrock-kb-role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
    });

    const kbPolicy = new iam.ManagedPolicy(this, 'BedrockKBPolicy', {
      managedPolicyName: 'schoolbot-bedrock-kb-policy',
      statements: [
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [
            transcriptBucket.bucketArn,
            `${transcriptBucket.bucketArn}/*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: [
            's3vectors:GetIndex',
            's3vectors:GetVectorBucket',
            's3vectors:PutVectors',
            's3vectors:GetVectors',
            's3vectors:DeleteVectors',
            's3vectors:QueryVectors',
            's3vectors:ListVectors',
          ],
          resources: [
            `arn:aws:s3vectors:${this.region}:${this.account}:bucket/schoolbot-vectors-${this.account}-${this.region}`,
            `arn:aws:s3vectors:${this.region}:${this.account}:bucket/schoolbot-vectors-${this.account}-${this.region}/index/schoolbot-index-v3`,
          ],
        }),
      ],
    });
    kbRole.addManagedPolicy(kbPolicy);

    // ── Bedrock Knowledge Base ────────────────────────────────────────────────
    const knowledgeBase = new cdk.CfnResource(this, 'KnowledgeBase', {
      type: 'AWS::Bedrock::KnowledgeBase',
      properties: {
        Name: 'schoolbot-knowledge-base-v3',
        Description: 'The Beam – school board meeting transcripts knowledge base',
        RoleArn: kbRole.roleArn,
        KnowledgeBaseConfiguration: {
          Type: 'VECTOR',
          VectorKnowledgeBaseConfiguration: {
            EmbeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
            EmbeddingModelConfiguration: {
              BedrockEmbeddingModelConfiguration: {
                Dimensions: 1024,
              },
            },
          },
        },
        StorageConfiguration: {
          Type: 'S3_VECTORS',
          S3VectorsConfiguration: {
            VectorBucketArn: `arn:aws:s3vectors:${this.region}:${this.account}:bucket/schoolbot-vectors-${this.account}-${this.region}`,
            IndexName: 'schoolbot-index-v3',
          },
        },
      },
    });
    knowledgeBase.addDependency(vectorIndex);
    knowledgeBase.node.addDependency(kbPolicy);

    // ── Bedrock Knowledge Base Data Source (S3 transcript bucket) ────────────
    const kbDataSource = new bedrock.CfnDataSource(this, 'KBDataSource', {
      name: 'schoolbot-transcripts-datasource',
      knowledgeBaseId: knowledgeBase.getAtt('KnowledgeBaseId').toString(),
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: transcriptBucket.bucketArn,
          inclusionPrefixes: ['transcripts/'],
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: 512,
            overlapPercentage: 20,
          },
        },
      },
    });

    // ── Lambda defaults ───────────────────────────────────────────────────────
    const commonEnv = {
      TRANSCRIPTS_BUCKET: transcriptBucket.bucketName,
      DISTRICTS_TABLE: districtsTable.tableName,
      TRANSCRIPTS_TABLE: transcriptsTable.tableName,
      QUERY_LOGS_TABLE: queryLogsTable.tableName,
      BEDROCK_KB_ID: knowledgeBase.getAtt('KnowledgeBaseId').toString(),
      BEDROCK_KB_DATA_SOURCE_ID: kbDataSource.attrDataSourceId,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      NODE_OPTIONS: '--enable-source-maps',
    };

    const lambdaLogGroup = (id: string) => new logs.LogGroup(this, id, {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const lambdaDefaults = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
    } satisfies Partial<lambda.FunctionProps>;

    // ── Chatbot API Lambda ────────────────────────────────────────────────────
    const chatbotApiFn = new lambda.Function(this, 'ChatbotApiFn', {
      ...lambdaDefaults,
      functionName: 'schoolbot-chatbot-api',
      code: lambda.Code.fromAsset('lambda/chatbot-api'),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      logGroup: lambdaLogGroup('ChatbotApiFnLogGroup'),
      environment: {
        ...commonEnv,
        BEDROCK_REGION: this.region,
        BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    });

    queryLogsTable.grantWriteData(chatbotApiFn);
    chatbotApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:RetrieveAndGenerate',
          'bedrock:Retrieve',
          'bedrock:InvokeModel',
        ],
        resources: ['*'],
      }),
    );

    // ── Admin API Lambda ──────────────────────────────────────────────────────
    const adminApiFn = new lambda.Function(this, 'AdminApiFn', {
      ...lambdaDefaults,
      functionName: 'schoolbot-beam-admin-api',
      code: lambda.Code.fromAsset('lambda/admin-api'),
      handler: 'index.handler',
      logGroup: lambdaLogGroup('AdminApiFnLogGroup'),
      environment: {
        ...commonEnv,
      },
    });

    transcriptBucket.grantReadWrite(adminApiFn);
    districtsTable.grantReadWriteData(adminApiFn);
    transcriptsTable.grantReadWriteData(adminApiFn);
    adminApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartIngestionJob'],
        resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
      }),
    );

    // ── Transcript Processor Lambda (S3 upload triggered) ────────────────────
    const transcriptProcessorFn = new lambda.Function(this, 'TranscriptProcessorFn', {
      ...lambdaDefaults,
      functionName: 'schoolbot-transcript-processor',
      code: lambda.Code.fromAsset('lambda/transcript-processor'),
      handler: 'index.handler',
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      logGroup: lambdaLogGroup('TranscriptProcessorLogGroup'),
      environment: {
        ...commonEnv,
      },
    });

    transcriptBucket.grantReadWrite(transcriptProcessorFn);
    transcriptsTable.grantReadWriteData(transcriptProcessorFn);
    transcriptProcessorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'transcribe:StartTranscriptionJob',
          'transcribe:GetTranscriptionJob',
        ],
        resources: ['*'],
      }),
    );
    transcriptProcessorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartIngestionJob'],
        resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
      }),
    );

    // Trigger transcript processor when audio/video is uploaded to uploads/ prefix
    transcriptBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(transcriptProcessorFn),
      { prefix: 'uploads/' },
    );

    // ── API Gateway ───────────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'SchoolbotApi', {
      restApiName: 'schoolbot-beam-api',
      description: 'The Beam Schoolbot API',
      binaryMediaTypes: ['audio/*', 'video/*', 'application/octet-stream', 'multipart/form-data'],
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
      },
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        metricsEnabled: true,
      },
    });

    const chatIntegration = new apigateway.LambdaIntegration(chatbotApiFn, {
      timeout: cdk.Duration.seconds(29),
    });
    const adminIntegration = new apigateway.LambdaIntegration(adminApiFn);

    const chatResource = api.root.addResource('chat');
    chatResource.addMethod('POST', chatIntegration);

    const districtsResource = api.root.addResource('districts');
    districtsResource.addMethod('GET', adminIntegration);

    const adminResource = api.root.addResource('admin');
    const adminDistrictsResource = adminResource.addResource('districts');
    adminDistrictsResource.addMethod('GET', adminIntegration);
    adminDistrictsResource.addMethod('POST', adminIntegration);

    const adminDistrictItem = adminDistrictsResource.addResource('{districtId}');
    adminDistrictItem.addMethod('PUT', adminIntegration);
    adminDistrictItem.addMethod('DELETE', adminIntegration);

    const adminTranscriptsResource = adminResource.addResource('transcripts');
    adminTranscriptsResource.addMethod('GET', adminIntegration);
    adminTranscriptsResource.addMethod('POST', adminIntegration); // Upload transcript

    const adminTranscriptItem = adminTranscriptsResource.addResource('{districtId}');
    adminTranscriptItem.addMethod('GET', adminIntegration);

    // Upload endpoint — returns presigned URL for direct S3 upload
    const adminUploadResource = adminResource.addResource('upload');
    adminUploadResource.addMethod('POST', adminIntegration);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
      exportName: 'SchoolbotBeamApiUrl',
    });

    new cdk.CfnOutput(this, 'TranscriptBucketName', {
      value: transcriptBucket.bucketName,
      description: 'S3 bucket for transcripts',
      exportName: 'SchoolbotBeamTranscriptBucket',
    });

    new cdk.CfnOutput(this, 'DistrictsTableName', {
      value: districtsTable.tableName,
    });

    new cdk.CfnOutput(this, 'TranscriptsTableName', {
      value: transcriptsTable.tableName,
    });

    new cdk.CfnOutput(this, 'VectorBucketName', {
      value: `schoolbot-vectors-${this.account}-${this.region}`,
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBase.getAtt('KnowledgeBaseId').toString(),
      exportName: 'SchoolbotBeamKnowledgeBaseId',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseDataSourceId', {
      value: kbDataSource.attrDataSourceId,
    });
  }
}
