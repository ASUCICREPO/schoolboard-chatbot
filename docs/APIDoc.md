# API Documentation

Complete API reference for The Beam School Board AI platform.

**Base URL**: `https://<api-id>.execute-api.us-west-2.amazonaws.com/prod`

---

## Public Endpoints

These endpoints require no authentication.

### List Districts

```
GET /districts
```

Returns all districts with transcript counts and last updated timestamps.

**Response**:
```json
{
  "districts": [
    {
      "districtId": "blue-ridge-unified",
      "name": "Blue Ridge Unified",
      "youtubeUrl": "https://www.youtube.com/@blueridgeunifiedschooldist9674/streams",
      "status": "active",
      "transcriptCount": 3,
      "lastUpdated": "2026-04-30T18:00:00.000Z",
      "createdAt": "2026-04-30T17:00:00.000Z"
    }
  ]
}
```

### Chat (RAG Query)

```
POST /chat
```

Send a question to the AI chatbot. Answers are generated using Bedrock RetrieveAndGenerate with indexed meeting transcripts.

**Request Body**:
```json
{
  "query": "What was discussed at the last board meeting?",
  "districtId": "blue-ridge-unified",
  "sessionId": "optional-session-id-for-multi-turn"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | The question to ask (max 2000 chars) |
| `districtId` | string | No | Filter results to a specific district |
| `sessionId` | string | No | Continue a multi-turn conversation |

**Response**:
```json
{
  "answer": "At the Blue Ridge Unified board meeting on April 23, 2026, the board discussed...",
  "sessionId": "abc123-session-id",
  "citations": [
    {
      "content": "Excerpt from the transcript...",
      "location": "s3://schoolbot-transcripts-123456/transcripts/blue-ridge-unified/abc.txt",
      "metadata": {}
    }
  ]
}
```

**Error Responses**:
- `400` — Invalid or missing query
- `503` — Knowledge base not configured
- `500` — Internal error (check Lambda logs)

---

## Protected Endpoints

All `/admin/*` endpoints require a Cognito JWT token in the `Authorization` header.

```
Authorization: <id-token>
```

Tokens are obtained by signing in through the admin dashboard login page using `amazon-cognito-identity-js`.

---

### Districts

#### List Districts

```
GET /admin/districts
```

Returns all districts with transcript stats. Same response format as the public `/districts` endpoint.

#### Create District

```
POST /admin/districts
```

**Request Body**:
```json
{
  "id": "tempe-elementary",
  "name": "Tempe Elementary",
  "youtubeUrl": "https://www.youtube.com/@TempeESD/streams"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | No | District ID (auto-generated from name if omitted) |
| `name` | string | Yes | Display name |
| `youtubeUrl` | string | No | YouTube channel or playlist URL |
| `state` | string | No | State abbreviation (default: "AZ") |
| `description` | string | No | Optional description |

**Response**: `201` with the created district object.

#### Update District

```
PUT /admin/districts/{districtId}
```

**Request Body** (all fields optional):
```json
{
  "name": "Updated Name",
  "youtubeUrl": "https://new-url.com",
  "status": "active"
}
```

#### Delete District

```
DELETE /admin/districts/{districtId}
```

Permanently deletes the district record.

---

### Transcripts

#### List All Transcripts

```
GET /admin/transcripts
```

Returns all transcript records across all districts.

#### List Transcripts by District

```
GET /admin/transcripts/{districtId}
```

Returns transcripts for a specific district, sorted by date.

#### Get Transcript Content

```
GET /admin/transcripts/{districtId}?videoId={videoId}&view=content
```

Returns the full transcript text from S3.

**Response**:
```json
{
  "transcript": { "districtId": "...", "videoId": "...", "title": "...", "status": "completed" },
  "content": "Title: Board Meeting\nDistrict: blue-ridge-unified\n\nFull transcript text..."
}
```

#### Upload Transcript Text

```
POST /admin/transcripts
```

Directly upload transcript text (no file needed).

**Request Body**:
```json
{
  "districtId": "blue-ridge-unified",
  "title": "Board Meeting - April 2026",
  "text": "Full transcript text here..."
}
```

No character limit on the `text` field.

#### Delete Transcript

```
DELETE /admin/transcripts/{districtId}?videoId={videoId}
```

Deletes the transcript from both DynamoDB and S3, then triggers a KB re-sync.

---

### File Upload

#### Get Presigned Upload URL

```
POST /admin/upload
```

Returns a presigned S3 URL for direct file upload. Supports audio/video files (which trigger AWS Transcribe) and text files.

**Request Body**:
```json
{
  "districtId": "blue-ridge-unified",
  "title": "Board Meeting - April 2026",
  "fileName": "meeting.mp4",
  "contentType": "video/mp4"
}
```

**Supported file types**: `txt`, `vtt`, `srt`, `mp3`, `mp4`, `wav`, `webm`, `m4a`, `ogg`, `flac`

**Response**:
```json
{
  "uploadUrl": "https://s3.amazonaws.com/...",
  "s3Key": "uploads/blue-ridge-unified/abc123.mp4",
  "transcriptId": "abc123",
  "districtId": "blue-ridge-unified",
  "fileType": "mp4",
  "willTranscribe": true
}
```

After receiving the presigned URL, upload the file with a `PUT` request:
```
PUT <uploadUrl>
Content-Type: video/mp4
Body: <file-bytes>
```

---

### YouTube Monitor

#### Trigger Channel Scan

```
POST /admin/scan
```

Manually triggers the YouTube monitor to check all district channels for new videos.

**Response**:
```json
{
  "message": "Scan complete. Found 12 new video(s) across 72 districts.",
  "newVideos": 12,
  "errors": 2,
  "details": [
    { "districtId": "blue-ridge-unified", "total": 3, "new": 1 },
    { "districtId": "chandler-unified", "total": 3, "new": 0 }
  ]
}
```

#### List Discovered Videos

```
GET /admin/videos
```

Returns videos discovered by the YouTube monitor that haven't been transcribed yet (`status: 'discovered'`).

---

### Analytics

#### Get Usage Analytics

```
GET /admin/analytics
```

**Response**:
```json
{
  "totalQueries": 150,
  "answeredQueries": 120,
  "unansweredQueries": 30,
  "answerRate": 80,
  "uniqueSessions": 45,
  "avgQueryLength": 42,
  "avgAnswerLength": 350,
  "topDistricts": [
    { "districtId": "blue-ridge-unified", "count": 25 }
  ],
  "dailyTrend": [
    { "date": "2026-04-30", "count": 15 }
  ],
  "topConcerns": [
    {
      "topic": "Budget & Finance",
      "count": 30,
      "examples": ["What budget items were approved?", "Were there any spending cuts?"]
    }
  ]
}
```

**Concern Categories**: Budget & Finance, Curriculum & Academics, Safety & Security, Staffing & Personnel, Facilities & Construction, Policy & Governance, Community & Parents, Transportation, Special Education, Technology, Health & Wellness, General / Other
