# Deployment Guide

Step-by-step instructions for deploying The Beam School Board AI platform.

---

## Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | 20+ | Lambda runtime and frontend |
| AWS CLI | 2.x | AWS resource management |
| AWS CDK | 2.x | Infrastructure deployment |
| AWS Account | — | With Bedrock model access enabled |
| YouTube Data API v3 Key | — | Channel monitoring |

### Install CDK

```bash
npm install -g aws-cdk
```

### Enable Bedrock Models

In the AWS Console, navigate to **Bedrock → Model access** and enable:
- Amazon Titan Embed Text v2
- Anthropic Claude Haiku 4.5

Both must be enabled in your deployment region (default: `us-west-2`).

### Get a YouTube API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or select existing)
3. Enable **YouTube Data API v3** under APIs & Services → Library
4. Create an API key under APIs & Services → Credentials
5. Copy the key

---

## Step 1: Clone and Install

```bash
git clone https://github.com/your-org/schoolbot.git
cd schoolbot/cdk
npm install
```

---

## Step 2: Configure Environment

Create `cdk/.env`:

```bash
YOUTUBE_API_KEY=AIzaSy-your-youtube-api-key
```

---

## Step 3: Bootstrap CDK (First Time Only)

```bash
cdk bootstrap aws://<ACCOUNT_ID>/us-west-2
```

---

## Step 4: Deploy the Stack

```bash
cdk deploy
```

Or with a named AWS profile:

```bash
cdk deploy --profile your-profile
```

The deployment creates:
- S3 bucket for transcripts
- 3 DynamoDB tables (districts, transcripts, query-logs)
- S3 Vectors bucket and index
- Bedrock Knowledge Base with S3 data source
- 4 Lambda functions
- API Gateway with Cognito authorizer
- Cognito User Pool
- EventBridge rule (6-hour YouTube polling)

**Save the outputs** — you'll need `ApiUrl`, `UserPoolId`, and `UserPoolClientId`.

---

## Step 5: Create an Admin User

```bash
# Create user with temporary password
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username admin \
  --temporary-password "TempPass123!" \
  --message-action SUPPRESS

# Set permanent password (avoids forced password change)
aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username admin \
  --password "YourSecurePassword123!" \
  --permanent
```

---

## Step 6: Configure the Frontend

```bash
cd ../frontend
npm install
```

Create `frontend/.env`:

```
NEXT_PUBLIC_API_URL=https://<api-id>.execute-api.us-west-2.amazonaws.com/prod
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-west-2_XXXXXXXXX
NEXT_PUBLIC_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
```

Use the values from the CDK deploy output.

---

## Step 7: Run the Frontend

### Development

```bash
npm run dev
```

Visit `http://localhost:3000` for the public chatbot and `http://localhost:3000/admin` for the admin dashboard.

### Production Build

```bash
npm run build
npm start
```

Or deploy to Vercel, Amplify, or any Next.js-compatible hosting.

---

## Step 8: Initial Setup

1. Log in to the admin dashboard at `/admin`
2. Go to the **Districts** tab — districts are auto-populated when you run a YouTube scan
3. Click **Scan YouTube Channels** in the New Videos tab
4. Upload transcripts for discovered videos
5. Verify the chatbot works by asking a question on a district page

---

## Updating the Deployment

After making code changes:

```bash
cd cdk
cdk deploy
```

CDK automatically detects changed Lambda code and updates only what's needed.

---

## Destroying the Stack

To remove all AWS resources:

```bash
cdk destroy
```

DynamoDB tables with `removalPolicy: RETAIN` will survive the destroy. Delete them manually if needed:

```bash
aws dynamodb delete-table --table-name schoolbot-districts
aws dynamodb delete-table --table-name schoolbot-transcripts
aws dynamodb delete-table --table-name schoolbot-query-logs
```

---

## Environment Variables Reference

### CDK (`cdk/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `YOUTUBE_API_KEY` | Yes | YouTube Data API v3 key |

### Frontend (`frontend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes | API Gateway URL from CDK output |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | Yes | Cognito User Pool ID from CDK output |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID` | Yes | Cognito App Client ID from CDK output |
