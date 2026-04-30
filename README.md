# The Beam — School Board AI

The Beam is an AI-powered platform that helps journalists and citizens understand what happened at Arizona school board meetings. It monitors YouTube channels for new board meeting videos, allows admins to upload transcripts, and provides a conversational AI chatbot that answers questions based on meeting transcripts using RAG (Retrieval-Augmented Generation).

---

## Disclaimers

Customers are responsible for making their own independent assessment of the information in this document. This document:

(a) is for informational purposes only,

(b) references AWS product offerings and practices, which are subject to change without notice,

(c) does not create any commitments or assurances from AWS and its affiliates, suppliers or licensors. AWS products or services are provided "as is" without warranties, representations, or conditions of any kind, whether express or implied. The responsibilities and liabilities of AWS to its customers are controlled by AWS agreements, and this document is not part of, nor does it modify, any agreement between AWS and its customers, and

(d) is not to be considered a recommendation or viewpoint of AWS.

Additionally, you are solely responsible for testing, security and optimizing all code and assets on GitHub repo, and all such code and assets should be considered:

(a) as-is and without warranties or representations of any kind,

(b) not suitable for production environments, or on production or other critical data, and

(c) to include shortcuts in order to support rapid prototyping such as, but not limited to, relaxed authentication and authorization and a lack of strict adherence to security best practices.

All work produced is open source. More information can be found in the GitHub repo.

---

## Table of Contents

| Index                                               | Description                                             |
| :-------------------------------------------------- | :------------------------------------------------------ |
| [High Level Architecture](#high-level-architecture) | High level overview illustrating component interactions |
| [Documentation](#documentation)                     | Links to detailed documentation                         |
| [Deployment Guide](#deployment-guide)               | How to deploy the project                               |
| [User Guide](#user-guide)                           | End-user instructions and walkthrough                   |
| [API Documentation](#api-documentation)             | Documentation on the APIs the project uses              |
| [Directories](#directories)                         | General project directory structure                     |
| [Modification Guide](#modification-guide)           | Guide for developers extending the project              |
| [Troubleshooting](#troubleshooting)                 | Common issues and solutions                             |
| [Credits](#credits)                                 | Contributors and acknowledgments                        |
| [License](#license)                                 | License information                                     |

---

## High Level Architecture

The Beam uses a serverless AWS architecture. An EventBridge rule triggers a YouTube monitor Lambda every 6 hours that uses the YouTube Data API v3 to discover new board meeting videos across 72 Arizona school districts. Admins review discovered videos in a Cognito-authenticated dashboard and upload transcripts (text or audio/video files). Audio/video uploads trigger an S3 event that invokes a transcript processor Lambda, which uses AWS Transcribe to convert speech to text. All transcripts are stored in S3 and indexed into a Bedrock Knowledge Base backed by S3 Vectors. The chatbot API uses Bedrock's RetrieveAndGenerate to answer user questions with citations from the indexed transcripts. The frontend is a Next.js application with a public chatbot interface and a protected admin dashboard.


```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  YouTube Data   │────▶│  YouTube Monitor  │────▶│  DynamoDB           │
│  API v3         │     │  Lambda (6hr)     │     │  (transcripts table)│
└─────────────────┘     └──────────────────┘     └─────────────────────┘
                                                           │
┌─────────────────┐     ┌──────────────────┐               ▼
│  Admin Dashboard│────▶│  Admin API       │────▶┌─────────────────────┐
│  (Next.js)      │     │  Lambda          │     │  S3 Transcript      │
│  + Cognito Auth │     └──────────────────┘     │  Bucket             │
└─────────────────┘              │               └────────┬────────────┘
                                 │                        │
                        ┌────────▼─────────┐              │
                        │  Transcript      │              │
                        │  Processor Lambda│◀─────────────┘
                        │  (S3 trigger)    │        (audio/video uploads)
                        └────────┬─────────┘
                                 │ AWS Transcribe
                                 ▼
                        ┌──────────────────┐     ┌─────────────────────┐
                        │  Bedrock         │────▶│  S3 Vectors         │
                        │  Knowledge Base  │     │  (embeddings)       │
                        └────────┬─────────┘     └─────────────────────┘
                                 │
┌─────────────────┐     ┌────────▼─────────┐
│  Public Chatbot │────▶│  Chatbot API     │
│  (Next.js)      │     │  Lambda (RAG)    │
└─────────────────┘     └──────────────────┘
```

---

## Quick Start

### 1. Configure AWS credentials

```bash
# For AWS SSO (recommended)
aws sso login --profile your-profile-name
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-west-2
```

### 2. Clone the repository

```bash
git clone https://github.com/ASUCICREPO/schoolbot.git
cd schoolbot
```

### 3. Get a YouTube Data API v3 key

Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create API Key. Enable the YouTube Data API v3.

### 4. Store a GitHub token (for Amplify auto-deploy)

Create a [GitHub Personal Access Token](https://github.com/settings/tokens) with `repo` scope, then store it in Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name "github-token" \
  --description "GitHub Personal Access Token for Amplify" \
  --secret-string "your-github-token-here" \
  --region us-west-2
```

### 5. Run the deployment script

```bash
bash ./deploy.sh
```

The script handles prerequisites, AWS credentials, GitHub token, YouTube API key, CDK bootstrap, stack deployment, admin user creation, and Amplify hosting — all in one command.

### 6. Access the app

After deployment, the Amplify URL is shown in the output. The frontend auto-deploys on every push to `main`.

---

## Documentation

| Document | Description |
| :------- | :---------- |
| [API Documentation](./docs/APIDoc.md) | Comprehensive API reference for all endpoints |
| [Architecture Deep Dive](./docs/architectureDeepDive.md) | Detailed system architecture and design |
| [Deployment Guide](./docs/deploymentGuide.md) | Deployment instructions, prerequisites and step-by-steps |
| [User Guide](./docs/userGuide.md) | Step-by-step usage instructions |
| [Modification Guide](./docs/modificationGuide.md) | Guide for customizing and extending the system |
| [Model Justification](./docs/modelJustification.md) | Rationale for AI model selection |

---

## Deployment Guide

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- A YouTube Data API v3 key ([Google Cloud Console](https://console.cloud.google.com))

### Step 1: Deploy the CDK Stack

```bash
cd cdk
npm install

# Add your YouTube API key
echo "YOUTUBE_API_KEY=your-key-here" > .env

# Deploy
cdk deploy --profile your-aws-profile
```

The deploy outputs will include:
- `ApiUrl` — API Gateway endpoint
- `UserPoolId` — Cognito User Pool ID
- `UserPoolClientId` — Cognito App Client ID
- `TranscriptBucketName` — S3 bucket for transcripts
- `KnowledgeBaseId` — Bedrock Knowledge Base ID

### Step 2: Create an Admin User

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username admin \
  --temporary-password "TempPass123!" \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username admin \
  --password "YourPermanentPassword!" \
  --permanent
```

### Step 3: Configure the Frontend

```bash
cd frontend
npm install

# Create .env with your values from the CDK deploy output
cat > .env << EOF
NEXT_PUBLIC_API_URL=<ApiUrl>
NEXT_PUBLIC_COGNITO_USER_POOL_ID=<UserPoolId>
NEXT_PUBLIC_COGNITO_CLIENT_ID=<UserPoolClientId>
EOF

npm run dev
```

### Step 4: Add Districts

Districts are defined in `cdk/lambda/youtube-monitor/districts.mjs`. Each entry has an `id`, `name`, and `youtubeUrl`. The YouTube monitor uses these to discover new videos. Districts can also be added through the admin dashboard.

---

## User Guide

### Public Chatbot

1. Visit the landing page to see all available school districts
2. Click a district to open its chatbot
3. Ask questions about board meetings — the AI answers using indexed transcripts
4. Suggested questions are provided for each district

### Admin Dashboard

Access the admin dashboard at `/admin`. Login with your Cognito credentials.

**Districts Tab**
- View, search, add, edit, and delete school districts
- Each district shows its YouTube URL, transcript count, and last updated date

**New Videos Tab**
- Click "Scan YouTube Channels" to check all districts for new board meeting videos
- Videos are grouped by district with thumbnails and YouTube links
- Search by district name to find specific channels
- Upload audio/video files or paste transcript text directly for each video

**Transcripts Tab**
- View all transcripts grouped by district
- Click "View" to read the full transcript text
- Delete transcripts that are no longer needed
- Deleting a transcript removes it from S3 and triggers a KB re-sync

**Analytics Tab**
- Total queries, answer rate, unique sessions
- Queries per day trend chart
- Most queried districts
- Top concerns categorized by topic (Budget, Safety, Staffing, etc.)

---

## API Documentation

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/districts` | List all districts with transcript counts |
| `POST` | `/chat` | Send a chat query (RAG) |

### Protected Endpoints (Cognito Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/districts` | List districts |
| `POST` | `/admin/districts` | Create a district |
| `PUT` | `/admin/districts/{districtId}` | Update a district |
| `DELETE` | `/admin/districts/{districtId}` | Delete a district |
| `GET` | `/admin/transcripts` | List all transcripts |
| `GET` | `/admin/transcripts/{districtId}` | List transcripts for a district |
| `GET` | `/admin/transcripts/{districtId}?videoId=X&view=content` | Get transcript text |
| `POST` | `/admin/transcripts` | Upload transcript text |
| `DELETE` | `/admin/transcripts/{districtId}?videoId=X` | Delete a transcript |
| `POST` | `/admin/upload` | Get presigned URL for audio/video upload |
| `POST` | `/admin/scan` | Trigger YouTube channel scan |
| `GET` | `/admin/videos` | List discovered (untranscribed) videos |
| `GET` | `/admin/analytics` | Get usage analytics |

### Chat Request

```json
{
  "query": "What was discussed at the last board meeting?",
  "districtId": "blue-ridge-unified",
  "sessionId": "optional-session-id"
}
```

### Chat Response

```json
{
  "answer": "At the Blue Ridge Unified board meeting on April 23, 2026...",
  "sessionId": "session-id",
  "citations": [
    {
      "content": "excerpt from transcript...",
      "location": "s3://bucket/transcripts/blue-ridge-unified/abc123.txt"
    }
  ]
}
```

---

## Directories

```
├── cdk/
│   ├── bin/
│   │   └── cdk.ts                          # CDK app entry point
│   ├── lib/
│   │   └── schoolbot-stack.ts              # Main CDK stack definition
│   ├── lambda/
│   │   ├── admin-api/
│   │   │   └── index.mjs                   # Admin API (districts, transcripts, upload, analytics)
│   │   ├── chatbot-api/
│   │   │   └── index.mjs                   # RAG chatbot using Bedrock KB
│   │   ├── transcript-processor/
│   │   │   └── index.mjs                   # S3-triggered audio/video → Transcribe → S3
│   │   └── youtube-monitor/
│   │       ├── index.mjs                   # YouTube Data API v3 channel monitor
│   │       └── districts.mjs               # District YouTube channel list
│   ├── .env                                # YouTube API key (not committed)
│   ├── .env.example                        # Environment variable template
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── admin/page.tsx              # Admin dashboard page
│   │   │   ├── district/[districtId]/page.tsx  # District chat page
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx                    # Landing page
│   │   ├── components/
│   │   │   ├── AdminDashboard.tsx          # Admin dashboard (4 tabs)
│   │   │   ├── ChatMessage.tsx             # Chat message bubble
│   │   │   ├── ChatWindow.tsx              # General chat interface
│   │   │   ├── DistrictChatPage.tsx        # District-specific chat
│   │   │   ├── DistrictSelector.tsx        # District dropdown
│   │   │   └── LandingPage.tsx             # Public landing page
│   │   ├── lib/
│   │   │   ├── api.ts                      # API client functions
│   │   │   ├── auth.ts                     # Cognito authentication
│   │   │   ├── districts.ts                # Static district data (fallback)
│   │   │   └── uuid.ts                     # UUID generator
│   │   └── types/
│   │       └── index.ts                    # TypeScript interfaces
│   ├── .env                                # API URL + Cognito config
│   ├── package.json
│   └── tsconfig.json
├── District YouTube channels.csv           # Source CSV of district YouTube URLs
├── mock-transcripts/                       # Sample transcript files (216 files)
└── README.md
```

### Directory Explanations

1. **cdk/** — AWS CDK infrastructure and Lambda functions
   - `lambda/admin-api/` — Handles district CRUD, transcript management, file uploads, YouTube scan trigger, and analytics
   - `lambda/chatbot-api/` — RAG chatbot using Bedrock RetrieveAndGenerate with district-scoped queries
   - `lambda/transcript-processor/` — Triggered by S3 uploads of audio/video, runs AWS Transcribe, stores results, syncs KB
   - `lambda/youtube-monitor/` — Polls YouTube channels via Data API v3, discovers new videos, filters upcoming/live

2. **frontend/** — Next.js application
   - Public chatbot with per-district pages and suggested questions
   - Admin dashboard with Cognito authentication (Districts, New Videos, Transcripts, Analytics tabs)

3. **mock-transcripts/** — 216 sample transcript files used during development

---

## Modification Guide

### Adding a New District

1. Add the district to `cdk/lambda/youtube-monitor/districts.mjs` with `id`, `name`, and `youtubeUrl`
2. Deploy: `cdk deploy`
3. Or add it through the admin dashboard's Districts tab

### Changing the Polling Frequency

Edit `cdk/lib/schoolbot-stack.ts` — find the `YoutubeMonitorSchedule` EventBridge rule and change `cdk.Duration.hours(6)` to your desired interval. The YouTube API quota allows ~70 runs per day.

### Changing the AI Model

Edit `cdk/lib/schoolbot-stack.ts` — find `BEDROCK_MODEL_ID` in the chatbot Lambda environment and change it. The model must support Bedrock's RetrieveAndGenerate API.

### Adding Analytics Categories

Edit `cdk/lambda/admin-api/index.mjs` — find the `topicKeywords` object in the `getAnalytics` function and add new categories with their keyword arrays.

### Customizing the System Prompt

Edit `cdk/lambda/chatbot-api/index.mjs` — modify the `SYSTEM_PROMPT` constant to change how the AI responds to queries.

---

## Troubleshooting

### Chatbot Returns "Unable to Assist"

**Issue**: The chatbot refuses to answer or says it doesn't have information.

**Solutions**:
1. Verify transcripts exist in S3: `aws s3 ls s3://<bucket>/transcripts/ --recursive`
2. Trigger a KB sync: `aws bedrock-agent start-ingestion-job --knowledge-base-id <id> --data-source-id <id>`
3. Wait 30-60 seconds for ingestion to complete
4. Check that the transcript file contains actual meeting content (not just metadata)

### KB Ingestion Fails

**Issue**: `StartIngestionJob` returns an error about permissions.

**Solutions**:
1. Verify the KB role has `bedrock:InvokeModel` permission on `*`
2. Check that the S3 bucket policy allows the KB role to read objects
3. Redeploy: `cdk deploy`

### YouTube Scan Finds No Videos

**Issue**: "Scan YouTube Channels" returns 0 new videos for all districts.

**Solutions**:
1. Check that `YOUTUBE_API_KEY` is set in `cdk/.env`
2. Verify the API key is valid and has YouTube Data API v3 enabled
3. Check the YouTube monitor logs for specific errors
4. Ensure district YouTube URLs are correct in `districts.mjs`

### CORS Errors in Browser

**Issue**: Browser console shows CORS policy errors.

**Solutions**:
1. Verify the API Gateway has CORS configured (check CDK stack)
2. Ensure gateway responses include `Access-Control-Allow-Origin` headers
3. Redeploy: `cdk deploy`

### 401 Unauthorized on Admin Endpoints

**Issue**: Admin API calls return 401.

**Solutions**:
1. Verify you're logged in (check browser localStorage for Cognito tokens)
2. Tokens expire after 1 hour — refresh the page to get a new token
3. Verify the Cognito User Pool ID and Client ID in `frontend/.env`

### CDK Deploy Fails with Bucket Already Exists

**Issue**: CloudFormation fails because an S3 bucket already exists.

**Solutions**:
1. Delete the existing bucket: `aws s3 rb s3://<bucket-name> --force`
2. Or import it using `s3.Bucket.fromBucketName()` in the CDK stack
3. Redeploy: `cdk deploy`

### Transcript Upload Shows 502

**Issue**: Uploading a transcript via the admin dashboard returns 502.

**Solutions**:
1. The transcript was likely saved successfully — check the Transcripts tab
2. The 502 is caused by the KB sync taking too long (API Gateway 29s limit)
3. This is cosmetic — the transcript is stored and will be indexed

---

## Credits

This application was developed by:

- <a href="https://www.linkedin.com/in/shawnneill24/" target="_blank">Shawn Neill</a>
- <a href="https://www.linkedin.com/in/shakthiarun22/" target="_blank">Lahari Shakthi Arun</a>
- <a href="https://www.linkedin.com/in/jennnyen/" target="_blank">Jenny Nguyen</a>

Built for The Beam at the ASU Walter Cronkite School of Journalism and Mass Communication.

---

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
