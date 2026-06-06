#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { JanewayContentStack } from '../lib/janeway-content-stack'

const app = new cdk.App()

new JanewayContentStack(app, 'JanewayContentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '486207805298',
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
})
