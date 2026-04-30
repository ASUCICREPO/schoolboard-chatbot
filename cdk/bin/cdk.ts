#!/usr/bin/env node
import 'source-map-support/register';
import { config } from 'dotenv';
import * as cdk from 'aws-cdk-lib';
import { SchoolbotStack } from '../lib/schoolbot-stack';

config();

const app = new cdk.App();
new SchoolbotStack(app, 'SchoolbotStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
  },
  description: 'The Beam - AI-powered school board meeting transcript chatbot',
});
