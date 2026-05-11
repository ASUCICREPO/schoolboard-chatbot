# Modification Guide

Guide for developers looking to customize and extend The Beam School Board AI.

---

## Project Structure Overview

The project has two main directories:

- **`cdk/`** — AWS infrastructure (CDK stack) and Lambda functions
- **`frontend/`** — Next.js web application

All infrastructure is defined in `cdk/lib/schoolbot-stack.ts`. Lambda functions are in `cdk/lambda/`. The frontend is a standard Next.js App Router project.

---

## Adding a New District

### Option 1: Admin Dashboard

1. Go to `/admin` → Districts tab
2. Click "+ Add District"
3. Enter the ID, name, and YouTube URL

### Option 2: Code

Add an entry to `cdk/lambda/youtube-monitor/districts.mjs`:

```javascript
{ id: 'new-district', name: 'New District', youtubeUrl: 'https://www.youtube.com/@channel/streams' },
```

Then deploy: `cdk deploy`

The YouTube monitor uses this list to discover videos. Districts added via the admin dashboard are stored in DynamoDB. The monitor seeds DynamoDB from the hardcoded list on each run (idempotent).

---

## Changing the AI Model

Edit `cdk/lib/schoolbot-stack.ts`:

```typescript
BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
```

Change to any model that supports Bedrock's RetrieveAndGenerate API. Cross-region inference profiles use the `us.` prefix. Foundation models use the full model ID.

The Lambda IAM policy already has `bedrock:*` on `*`, so no permission changes are needed.

---

## Customizing the System Prompt

Edit `cdk/lambda/chatbot-api/index.mjs`:

```javascript
const SYSTEM_PROMPT = `Your custom prompt here...`;
```

The prompt template uses Bedrock's `$search_results$` and `$query$` variables:

```
${SYSTEM_PROMPT}\n\n$search_results$\n\nHuman: $query$\nAssistant:
```

---

## Changing the Polling Frequency

Edit `cdk/lib/schoolbot-stack.ts`:

```typescript
schedule: events.Schedule.rate(cdk.Duration.hours(6)),
```

The YouTube API quota allows ~70 runs per day (10,000 units / ~144 units per run). You could poll every hour and stay within limits.

---

## Updating list of schools permanently through deployments

Edit `cdk/lambda/districts.mjs`:

Add to the list of schools following the same format.

---

## Adding a New API Endpoint

1. **Add the handler function** in `cdk/lambda/admin-api/index.mjs`:

```javascript
async function myNewEndpoint(body) {
  // your logic
  return buildResponse(200, { result: 'ok' });
}
```

2. **Add the route** in the router section of the same file:

```javascript
if (path.includes('/admin/my-endpoint') && method === 'POST') {
  return myNewEndpoint(JSON.parse(event.body ?? '{}'));
}
```

3. **Add the API Gateway resource** in `cdk/lib/schoolbot-stack.ts`:

```typescript
const myResource = adminResource.addResource('my-endpoint');
myResource.addMethod('POST', adminIntegration, authMethodOptions);
```

4. Deploy: `cdk deploy`

---

## Adding a New Analytics Category

Edit `cdk/lambda/admin-api/index.mjs` — find the `topicKeywords` object:

```javascript
const topicKeywords = {
  'Budget & Finance': ['budget', 'finance', ...],
  'Your New Category': ['keyword1', 'keyword2', 'keyword3'],
};
```

Queries are matched against keywords (case-insensitive). The first matching category wins. Unmatched queries go to "General / Other".

---

## Modifying the Knowledge Base

### Changing Chunk Size

Edit `cdk/lib/schoolbot-stack.ts`:

```typescript
fixedSizeChunkingConfiguration: {
  maxTokens: 512,      // Increase for longer context per chunk
  overlapPercentage: 20, // Increase for more context overlap
},
```

### Changing Embedding Model

Edit the `EmbeddingModelArn` and `Dimensions` in the KB configuration. Make sure the KB role has `bedrock:InvokeModel` permission for the new model.

### Changing Number of Search Results

Edit `cdk/lambda/chatbot-api/index.mjs`:

```javascript
numberOfResults: 5, // Increase for more context, decrease for speed
```

---

## Adding a New Frontend Tab

1. Add the tab ID to the `TabId` type in `AdminDashboard.tsx`:

```typescript
type TabId = "districts" | "videos" | "transcripts" | "analytics" | "my-tab";
```

2. Add it to the `TABS` array:

```typescript
{ id: "my-tab", label: "My Tab" },
```

3. Add the tab content in the JSX:

```tsx
{tab === "my-tab" && (
  <div>Your tab content</div>
)}
```

---

## Changing Authentication


### Allowing Self-Registration

Change `selfSignUpEnabled: false` to `true` in the User Pool configuration. Consider adding email verification.

### Using a Different Auth Provider

Replace the Cognito authorizer with a custom Lambda authorizer or JWT authorizer. Update the frontend `auth.ts` to use the new provider.

---

## Transcript File Format

Transcripts stored in S3 follow this format:

```
Title: Board Meeting - April 2026
District: blue-ridge-unified
Transcript ID: abc123
Uploaded: 2026-04-30T18:00:00.000Z
Transcript Source: manual-upload

[Full transcript text follows...]
```

The header metadata is important — the chatbot uses `District:` to scope search results. If you modify the format, ensure the district identifier remains in the first few lines.

---

## Local Development

### Backend

Lambda functions can be tested locally by invoking them directly:

```bash
cd cdk
node -e "
import('./lambda/youtube-monitor/index.mjs').then(m => m.handler()).then(console.log)
"
```

Note: This requires AWS credentials and environment variables to be set.

### Frontend

```bash
cd frontend
npm run dev
```

The frontend connects to the deployed API Gateway. There's no local backend server — all API calls go to AWS.

### Deploying Changes

```bash
cd cdk
cdk deploy
```

CDK detects code changes automatically. Only modified Lambdas are re-uploaded.
