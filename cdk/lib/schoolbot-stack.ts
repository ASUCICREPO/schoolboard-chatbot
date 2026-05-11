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
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export class SchoolbotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3 Transcript Bucket ─────────────────────────────────────────────────
    const transcriptBucket = new s3.Bucket(this, 'TranscriptBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
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
      partitionKey: { name: 'districtId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const transcriptsTable = new dynamodb.Table(this, 'TranscriptsTable', {
      partitionKey: { name: 'districtId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'videoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const queryLogsTable = new dynamodb.Table(this, 'QueryLogsTable', {
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
      indexName: 'schoolbot-index',
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
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
    });

    const kbPolicy = new iam.ManagedPolicy(this, 'BedrockKBPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: ['*'],
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
            `arn:aws:s3vectors:${this.region}:${this.account}:bucket/schoolbot-vectors-${this.account}-${this.region}/index/schoolbot-index`,
          ],
        }),
      ],
    });
    kbRole.addManagedPolicy(kbPolicy);

    // ── Bedrock Knowledge Base ────────────────────────────────────────────────
    const knowledgeBase = new cdk.CfnResource(this, 'KnowledgeBase', {
      type: 'AWS::Bedrock::KnowledgeBase',
      properties: {
        Name: `schoolbot-kb-${this.account}`,
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
            IndexName: 'schoolbot-index',
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

    // ── Cognito User Pool (admin authentication) ───────────────────────────────
    const userPool = new cognito.UserPool(this, 'AdminUserPool', {
      selfSignUpEnabled: false, // Admins added manually in console
      signInAliases: { username: true, email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient('AdminAppClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
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
      code: lambda.Code.fromAsset('lambda/chatbot-api'),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      logGroup: lambdaLogGroup('ChatbotApiFnLogGroup'),
      environment: {
        ...commonEnv,
        BEDROCK_REGION: this.region,
        BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        AWS_ACCOUNT_ID: this.account,
      },
    });

    queryLogsTable.grantWriteData(chatbotApiFn);
    chatbotApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:RetrieveAndGenerate',
          'bedrock:Retrieve',
          'bedrock:InvokeModel',
          'bedrock:GetInferenceProfile',
        ],
        resources: ['*'],
      }),
    );

    // ── Admin API Lambda ──────────────────────────────────────────────────────
    const adminApiFn = new lambda.Function(this, 'AdminApiFn', {
      ...lambdaDefaults,
      code: lambda.Code.fromAsset('lambda/admin-api'),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      logGroup: lambdaLogGroup('AdminApiFnLogGroup'),
      environment: {
        ...commonEnv,
        YOUTUBE_MONITOR_FN: '', // Set after monitor Lambda is created
      },
    });

    transcriptBucket.grantReadWrite(adminApiFn);
    districtsTable.grantReadWriteData(adminApiFn);
    transcriptsTable.grantReadWriteData(adminApiFn);
    queryLogsTable.grantReadData(adminApiFn);
    adminApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartIngestionJob'],
        resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
      }),
    );

    // ── Transcript Processor Lambda (S3 upload triggered) ────────────────────
    const transcriptProcessorFn = new lambda.Function(this, 'TranscriptProcessorFn', {
      ...lambdaDefaults,
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

    // ── YouTube Monitor Lambda (Data API v3, scheduled) ──────────────────────
    const youtubeMonitorFn = new lambda.Function(this, 'YoutubeMonitorFn', {
      ...lambdaDefaults,
      code: lambda.Code.fromAsset('lambda/youtube-monitor'),
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5),
      logGroup: lambdaLogGroup('YoutubeMonitorLogGroup'),
      environment: {
        TRANSCRIPTS_TABLE: transcriptsTable.tableName,
        DISTRICTS_TABLE: districtsTable.tableName,
        YOUTUBE_API_KEY_SECRET: 'schoolbot/youtube-api-key',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    transcriptsTable.grantReadWriteData(youtubeMonitorFn);
    districtsTable.grantWriteData(youtubeMonitorFn);
    youtubeMonitorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:schoolbot/youtube-api-key*`],
      }),
    );

    // Set the monitor function name on the admin API (forward reference)
    adminApiFn.addEnvironment('YOUTUBE_MONITOR_FN', youtubeMonitorFn.functionName);
    youtubeMonitorFn.grantInvoke(adminApiFn);

    // Poll every 6 hours (only ~72 quota units per run, well within 10,000/day)
    const monitorSchedule = new events.Rule(this, 'YoutubeMonitorSchedule', {
      ruleName: 'schoolbot-youtube-monitor',
      description: 'Check YouTube channels for new board meeting videos',
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
    });
    monitorSchedule.addTarget(new targets.LambdaFunction(youtubeMonitorFn, {
      retryAttempts: 2,
    }));

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

    // Add CORS headers to error responses (401, 403, 500)
    const corsResponseHeaders = {
      'Access-Control-Allow-Origin': "'*'",
      'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Api-Key'",
      'Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'",
    };
    api.addGatewayResponse('Unauthorized', {
      type: apigateway.ResponseType.UNAUTHORIZED,
      responseHeaders: corsResponseHeaders,
    });
    api.addGatewayResponse('AccessDenied', {
      type: apigateway.ResponseType.ACCESS_DENIED,
      responseHeaders: corsResponseHeaders,
    });
    api.addGatewayResponse('Default4xx', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: corsResponseHeaders,
    });
    api.addGatewayResponse('Default5xx', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: corsResponseHeaders,
    });

    const chatIntegration = new apigateway.LambdaIntegration(chatbotApiFn, {
      timeout: cdk.Duration.seconds(29),
    });
    const adminIntegration = new apigateway.LambdaIntegration(adminApiFn, {
      timeout: cdk.Duration.seconds(29),
    });

    // Cognito authorizer for admin routes
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'AdminAuthorizer', {
      authorizerName: 'schoolbot-admin-authorizer',
      cognitoUserPools: [userPool],
    });
    const authMethodOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // Public routes
    const chatResource = api.root.addResource('chat');
    chatResource.addMethod('POST', chatIntegration);

    const districtsResource = api.root.addResource('districts');
    districtsResource.addMethod('GET', adminIntegration);

    // Protected admin routes
    const adminResource = api.root.addResource('admin');
    const adminDistrictsResource = adminResource.addResource('districts');
    adminDistrictsResource.addMethod('GET', adminIntegration, authMethodOptions);
    adminDistrictsResource.addMethod('POST', adminIntegration, authMethodOptions);

    const adminDistrictItem = adminDistrictsResource.addResource('{districtId}');
    adminDistrictItem.addMethod('PUT', adminIntegration, authMethodOptions);
    adminDistrictItem.addMethod('DELETE', adminIntegration, authMethodOptions);

    const adminTranscriptsResource = adminResource.addResource('transcripts');
    adminTranscriptsResource.addMethod('GET', adminIntegration, authMethodOptions);
    adminTranscriptsResource.addMethod('POST', adminIntegration, authMethodOptions);

    const adminTranscriptItem = adminTranscriptsResource.addResource('{districtId}');
    adminTranscriptItem.addMethod('GET', adminIntegration, authMethodOptions);
    adminTranscriptItem.addMethod('DELETE', adminIntegration, authMethodOptions);

    const adminUploadResource = adminResource.addResource('upload');
    adminUploadResource.addMethod('POST', adminIntegration, authMethodOptions);

    // Trigger YouTube scan
    const adminScanResource = adminResource.addResource('scan');
    adminScanResource.addMethod('POST', adminIntegration, authMethodOptions);

    // Analytics
    const adminAnalyticsResource = adminResource.addResource('analytics');
    adminAnalyticsResource.addMethod('GET', adminIntegration, authMethodOptions);

    const adminVideosResource = adminResource.addResource('videos');
    adminVideosResource.addMethod('GET', adminIntegration, authMethodOptions);

    const adminVideosItem = adminVideosResource.addResource('{districtId}');
    adminVideosItem.addMethod('GET', adminIntegration, authMethodOptions);

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

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID (add admins here)',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID (for frontend login)',
    });
  }
}
