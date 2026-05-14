# Deployment Guide

Step-by-step instructions for deploying The Beam School Board AI platform.

 
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

### Get a GitHub Personal Access Token

1. Go to developer settings [Personal access tokens (classic)](https://github.com/settings/tokens)
2. Click Generate a new token (classic)
3. Name it in the Note section
4. Select scopes `repo` & `admin:repo_hook`
5. Click Generate token
6. Copy the token
 
## Clone and Install

```bash
git clone https://github.com/your-org/schoolbot.git
cd schoolbot/cdk
npm install
```

## Store YouTube API Key in Secrets Manager

```bash
aws secretsmanager create-secret \
  --name "schoolbot/youtube-api-key" \
  --description "YouTube Data API v3 key for channel monitoring" \
  --secret-string "YOUR_YOUTUBE_API_KEY" \
  --region us-west-2
```

To update an existing key:

```bash
aws secretsmanager put-secret-value \
  --secret-id "schoolbot/youtube-api-key" \
  --secret-string "YOUR_NEW_API_KEY" \
  --region us-west-2
```

> **Note**: The deploy script (`deploy.sh`) handles this automatically if the secret doesn't exist yet.

 
# Quick Start

1. **Configure AWS credentials**

```bash
# For AWS SSO (recommended)
aws sso login --profile your-profile-name
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-west-2
```

2. **Clone the repository**

```bash
git clone https://github.com/ASUCICREPO/schoolboard-chatbot.git
cd schoolbot
```

3. **Run the deployment script**

```bash
bash ./deploy.sh
```

# Manual Deploymnet Guide
 
## Step 1: Bootstrap CDK (First Time Only)

```bash
cdk bootstrap aws://<ACCOUNT_ID>/<ACCOUNT_REGION>
```

 
## Step 2: Deploy the Stack

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

 
## Step 3: Create an Admin User

```bash
# Create user with temporary password
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username admin \
  --temporary-password "TempPass123!" \
  --message-action SUPPRESS

# Set permanent password (make sure its at least 8 characters and contains an uppercase, lowercase, and number)
aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username admin \
  --password "<PASSWORD>" \
  --permanent
```

 
## Step 4: Configure the Frontend

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

 
## Step 5: Run the Frontend

### Development

```bash
npm run dev
```

Visit `http://localhost:3000` for the public chatbot and `http://localhost:3000/admin` for the admin dashboard.

### Production Build

```bash
npm run build
```

1. Go to the out folder created and zip all the contents INSIDE the out folder (do NOT zip the out folder itself)
2. Then go to Amplify in the AWS console and click 'Create new app'
3. Click 'Deploy without Git' and then 'Next'
4. Name the app, click 'Choose .zip folder', select the .zip folder from earlier, and click 'Save and deploy'

 
## Step 6: Initial Setup

1. Log in to the admin dashboard at `/admin`
2. Go to the **Districts** tab — districts are auto-populated when you run a YouTube scan
3. Click **Scan YouTube Channels** in the New Videos tab
4. Upload transcripts for discovered videos
5. Verify the chatbot works by asking a question on a district page

 
## Updating the Deployment

After making code changes:

```bash
cd cdk
cdk deploy
```

CDK automatically detects changed Lambda code and updates only what's needed.

 
## Destroying the Stack

To remove all AWS resources:

```bash
cdk destroy
```

> **Note**: The YouTube API key in Secrets Manager is not deleted by `cdk destroy`. Delete it manually if needed:
> ```bash
> aws secretsmanager delete-secret --secret-id "schoolbot/youtube-api-key" --force-delete-without-recovery --region us-west-2
> ```

 
## Secrets & Environment Variables Reference

### AWS Secrets Manager

| Secret Name | Description |
|-------------|-------------|
| `schoolbot/youtube-api-key` | YouTube Data API v3 key for channel monitoring |
| `schoolbot/github-token` | GitHub personal access token with repo and admin:repo_hook scopes |

### Frontend (`frontend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes | API Gateway URL from CDK output |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | Yes | Cognito User Pool ID from CDK output |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID` | Yes | Cognito App Client ID from CDK output |
