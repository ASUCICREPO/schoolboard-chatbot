# Architecture Deep Dive

Detailed system architecture and design decisions for The Beam School Board AI.

---

## System Overview

The Beam is a fully serverless application built on AWS. It consists of four main subsystems:

1. **YouTube Monitoring** — Discovers new board meeting videos
2. **Transcript Management** — Stores and processes meeting transcripts
3. **Knowledge Base** — Indexes transcripts for semantic search
4. **Chatbot** — Answers questions using RAG (Retrieval-Augmented Generation)

---

## AWS Services Used

| Service | Purpose |
|---------|---------|
| **API Gateway** | REST API with Cognito authorizer for admin routes |
| **Lambda** | 4 functions: admin API, chatbot API, transcript processor, YouTube monitor |
| **DynamoDB** | 3 tables: districts, transcripts, query logs |
| **S3** | Transcript storage and audio/video staging |
| **Bedrock** | Knowledge Base (S3 Vectors) + Claude Haiku for RAG |
| **Cognito** | Admin user authentication |
| **EventBridge** | 6-hour schedule for YouTube channel polling |
| **Transcribe** | Speech-to-text for uploaded audio/video files |
| **CloudWatch** | Lambda logs with 2-week retention |
| **SecretsManager** | Stores Youtube API key |
| **CDK** | Infrastructure as code |

---

## Data Flow

### 1. Video Discovery

```
EventBridge (every 6 hours) → YouTube Monitor Lambda
    → YouTube Data API v3 (playlistItems.list + videos.list)
    → Filter: skip upcoming/live, skip already-known videos
    → DynamoDB: store as status='discovered'
```

The monitor resolves YouTube URLs to playlist IDs:
- `@handle/streams` → `channels.list(forHandle)` → uploads playlist (`UC` → `UU`)
- `/channel/UCxxx` → direct conversion to `UU` uploads playlist
- `/playlist?list=PLxxx` → use directly

Each playlist fetch costs 1 API quota unit. The `videos.list` call to check live status costs 1 unit per batch. Total: ~144 units per run, well within the 10,000 daily free tier.

### 2. Transcript Upload (Text)

```
Admin Dashboard → POST /admin/transcripts
    → Admin API Lambda
    → S3: store at transcripts/{districtId}/{id}.txt
    → DynamoDB: store record with status='completed'
    → Bedrock: StartIngestionJob (KB sync)
```

### 3. Transcript Upload (Audio/Video)

```
Admin Dashboard → POST /admin/upload (get presigned URL)
    → PUT to S3 presigned URL (uploads/{districtId}/{id}.ext)
    → S3 Event Notification (prefix: uploads/)
    → Transcript Processor Lambda
        → AWS Transcribe (StartTranscriptionJob)
        → Poll for completion (10s intervals, 14min max)
        → Fetch result, store at transcripts/{districtId}/{id}.txt
        → Clean up: delete upload + transcribe output
        → Bedrock: StartIngestionJob (KB sync)
```

### 4. Chatbot Query

```
User → POST /chat { query, districtId }
    → Chatbot API Lambda
    → Prepend district context: "[District: xxx] query"
    → Bedrock RetrieveAndGenerate
        → Vector search in S3 Vectors (top 5 results)
        → Claude Haiku generates answer with citations
    → DynamoDB: log query to query-logs table
    → Return answer + citations
```

---

## DynamoDB Table Schemas

### schoolbot-districts

| Key | Type | Description |
|-----|------|-------------|
| `districtId` (PK) | String | URL-friendly ID (e.g., "blue-ridge-unified") |
| `name` | String | Display name |
| `youtubeUrl` | String | YouTube channel/playlist URL |
| `status` | String | "active" or "inactive" |

### schoolbot-transcripts

| Key | Type | Description |
|-----|------|-------------|
| `districtId` (PK) | String | District ID |
| `videoId` (SK) | String | YouTube video ID or generated transcript ID |
| `title` | String | Video/meeting title |
| `status` | String | "discovered", "pending", "transcribing", "completed", "failed" |
| `s3Key` | String | S3 path to transcript file |
| `publishedAt` | String | ISO date of video publication |
| `thumbnail` | String | YouTube thumbnail URL |
| `transcriptSource` | String | "manual-upload" or "amazon-transcribe" |
| `transcriptLength` | String | Character count of transcript |

### schoolbot-query-logs

| Key | Type | Description |
|-----|------|-------------|
| `logId` (PK) | String | UUID |
| `districtId` | String | District queried (or "all") |
| `query` | String | User's question (first 500 chars) |
| `answered` | Boolean | Whether the AI provided a substantive answer |
| `timestamp` | String | ISO timestamp |
| `date` | String | Date portion for daily aggregation |

---

## Bedrock Knowledge Base

### Configuration

- **Embedding Model**: Amazon Titan Embed Text v2 (1024 dimensions)
- **Storage**: S3 Vectors with cosine distance metric
- **Chunking**: Fixed-size, 512 tokens with 20% overlap
- **Data Source**: S3 bucket, `transcripts/` prefix only
- **Generation Model**: Claude Haiku 4.5 (cross-region inference profile)

### District Filtering

S3 Vectors does not support metadata filtering. Instead, district-scoped queries are achieved by:

1. Each transcript file includes `District: {districtId}` in its header
2. The chatbot prepends `[District: {districtId}]` to the search query
3. The system prompt instructs the model to only use transcripts from the specified district
4. Vector similarity naturally ranks matching-district transcripts higher

### Ingestion

KB ingestion is triggered:
- After uploading a transcript (text paste)
- After the transcript processor completes (audio/video)
- After deleting a transcript
- Manually via the admin dashboard's scan button

Ingestion takes 30-60 seconds. During this window, the chatbot may not reflect the latest changes.

---

## Authentication

### Cognito User Pool

- Self-signup disabled — admins are created manually
- Username + password authentication (USER_PASSWORD_AUTH and USER_SRP_AUTH flows)
- No MFA required (can be enabled in the console)

### API Gateway Authorization

- Public routes (`/chat`, `/districts`): No auth
- Admin routes (`/admin/*`): Cognito User Pools Authorizer
- CORS gateway responses configured for 401, 403, 4xx, and 5xx to include proper headers

### Frontend Auth Flow

1. User enters credentials on `/admin` login page
2. `amazon-cognito-identity-js` authenticates against Cognito
3. JWT ID token stored in memory (not localStorage)
4. Token sent as `Authorization` header on all admin API calls
5. Token expires after 1 hour — page refresh re-authenticates from Cognito session

---

## Cost Considerations

| Component | Cost Driver | Estimate |
|-----------|-------------|----------|
| YouTube Data API | 10,000 free units/day | Free |
| Lambda | ~200 invocations/day | Free tier |
| DynamoDB | On-demand, low volume | ~$1/month |
| S3 | Transcript storage | < $1/month |
| Bedrock KB (S3 Vectors) | Vector storage + queries | ~$5-10/month |
| Bedrock Claude Haiku | Per-query generation | ~$0.001/query |
| Transcribe | $0.024/minute of audio | ~$2.88 per 2-hour meeting |
| Cognito | 50,000 free MAUs | Free |

The primary variable cost is AWS Transcribe for audio/video uploads. Text transcript uploads incur no Transcribe cost.
