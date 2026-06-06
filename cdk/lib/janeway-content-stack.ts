import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as iam from 'aws-cdk-lib/aws-iam'

export class JanewayContentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const bucket = new s3.Bucket(this, 'ContentBucket', {
      bucketName: `janeway-articles-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const table = new dynamodb.Table(this, 'ArticlesTable', {
      tableName: 'janeway-articles',
      partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    })

    table.addGlobalSecondaryIndex({
      indexName: 'byStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'publishedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    const distribution = new cloudfront.Distribution(this, 'ContentCdn', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      comment: 'Janeway article images CDN',
    })

    const publishUser = new iam.User(this, 'PublishUser', {
      userName: 'janeway-publisher',
    })

    bucket.grantReadWrite(publishUser)
    table.grantReadWriteData(publishUser)

    const ssrReadPolicy = new iam.ManagedPolicy(this, 'AmplifySsrReadPolicy', {
      managedPolicyName: 'janeway-amplify-ssr-read',
      description: 'Read access for Amplify SSR compute role to fetch articles',
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject'],
          resources: [`${bucket.bucketArn}/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:Scan',
          ],
          resources: [
            table.tableArn,
            `${table.tableArn}/index/*`,
          ],
        }),
      ],
    })

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'ARTICLES_BUCKET env var',
    })

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'ARTICLES_TABLE env var',
    })

    new cdk.CfnOutput(this, 'CdnUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'ARTICLES_IMAGE_CDN_URL env var',
    })

    new cdk.CfnOutput(this, 'SsrReadPolicyArn', {
      value: ssrReadPolicy.managedPolicyArn,
      description: 'Attach this policy to the Amplify Hosting compute role',
    })

    new cdk.CfnOutput(this, 'PublishUserName', {
      value: publishUser.userName,
      description: 'IAM user for the local publish script. Create access keys via console.',
    })
  }
}
