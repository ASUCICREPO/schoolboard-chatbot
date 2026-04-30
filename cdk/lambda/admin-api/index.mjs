import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { randomUUID } from 'crypto';

const region = process.env.AWS_REGION ?? 'us-east-1';
const ddbClient = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region });
const bedrockAgent = new BedrockAgentClient({ region });
const lambdaClient = new LambdaClient({ region });

const YOUTUBE_MONITOR_FN = process.env.YOUTUBE_MONITOR_FN;

const DISTRICTS_TABLE = process.env.DISTRICTS_TABLE;
const TRANSCRIPTS_TABLE = process.env.TRANSCRIPTS_TABLE;
const TRANSCRIPTS_BUCKET = process.env.TRANSCRIPTS_BUCKET;
const BEDROCK_KB_ID = process.env.BEDROCK_KB_ID;
const BEDROCK_KB_DATA_SOURCE_ID = process.env.BEDROCK_KB_DATA_SOURCE_ID;

function buildResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify(body),
  };
}

// ── District CRUD ────────────────────────────────────────────────────────────

async function listDistricts() {
  const [districtResult, transcriptResult] = await Promise.all([
    ddb.send(new ScanCommand({ TableName: DISTRICTS_TABLE })),
    ddb.send(new ScanCommand({
      TableName: TRANSCRIPTS_TABLE,
      ProjectionExpression: 'districtId, #st, createdAt',
      ExpressionAttributeNames: { '#st': 'status' },
    })),
  ]);

  const districts = districtResult.Items ?? [];
  const transcripts = transcriptResult.Items ?? [];

  // Calculate stats per district
  const stats = {};
  for (const t of transcripts) {
    if (t.status !== 'completed') continue;
    const d = t.districtId;
    if (!stats[d]) stats[d] = { count: 0, lastUpdated: '' };
    stats[d].count++;
    if (t.createdAt > stats[d].lastUpdated) stats[d].lastUpdated = t.createdAt;
  }

  // Attach stats to districts
  const enriched = districts.map((d) => ({
    ...d,
    transcriptCount: stats[d.districtId]?.count ?? 0,
    lastUpdated: stats[d.districtId]?.lastUpdated ?? null,
  }));

  return buildResponse(200, { districts: enriched });
}

async function createDistrict(body) {
  const { id, name, youtubeUrl, state, description } = body;
  if (!name) return buildResponse(400, { error: 'name is required' });

  const districtId = id || name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const item = {
    districtId,
    name,
    youtubeUrl: youtubeUrl ?? '',
    state: state ?? 'AZ',
    description: description ?? '',
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: DISTRICTS_TABLE, Item: item }));
  return buildResponse(201, { district: item });
}

async function updateDistrict(districtId, body) {
  const allowed = ['name', 'youtubeUrl', 'status', 'description', 'state'];
  const updates = Object.entries(body).filter(([k]) => allowed.includes(k));
  if (updates.length === 0) return buildResponse(400, { error: 'No valid fields to update' });

  const expr = updates.map(([k], i) => `#f${i} = :v${i}`).join(', ');
  const names = Object.fromEntries(updates.map(([k], i) => [`#f${i}`, k]));
  const values = Object.fromEntries(updates.map(([, v], i) => [`:v${i}`, v]));
  values[':ua'] = new Date().toISOString();

  await ddb.send(
    new UpdateCommand({
      TableName: DISTRICTS_TABLE,
      Key: { districtId },
      UpdateExpression: `SET ${expr}, updatedAt = :ua`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
  return buildResponse(200, { districtId, updated: Object.fromEntries(updates) });
}

async function deleteDistrict(districtId) {
  await ddb.send(
    new DeleteCommand({
      TableName: DISTRICTS_TABLE,
      Key: { districtId },
    }),
  );
  return buildResponse(200, { districtId, deleted: true });
}

// ── Transcript management ────────────────────────────────────────────────────

async function listTranscripts(districtId) {
  let items;
  if (districtId) {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TRANSCRIPTS_TABLE,
        KeyConditionExpression: 'districtId = :d',
        ExpressionAttributeValues: { ':d': districtId },
      }),
    );
    items = (result.Items ?? []).sort((a, b) =>
      (b.publishedAt ?? b.createdAt ?? '').localeCompare(a.publishedAt ?? a.createdAt ?? ''),
    );
  } else {
    const result = await ddb.send(new ScanCommand({ TableName: TRANSCRIPTS_TABLE }));
    items = result.Items ?? [];
  }
  return buildResponse(200, { transcripts: items });
}

async function getTranscriptUrl(districtId, videoId) {
  const item = await ddb.send(
    new GetCommand({ TableName: TRANSCRIPTS_TABLE, Key: { districtId, videoId } }),
  );
  if (!item.Item || !item.Item.s3Key) {
    return buildResponse(404, { error: 'Transcript not found' });
  }
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: TRANSCRIPTS_BUCKET, Key: item.Item.s3Key }),
    { expiresIn: 3600 },
  );
  return buildResponse(200, { url, transcript: item.Item });
}

async function getTranscriptContent(districtId, videoId) {
  const item = await ddb.send(
    new GetCommand({ TableName: TRANSCRIPTS_TABLE, Key: { districtId, videoId } }),
  );
  if (!item.Item || !item.Item.s3Key) {
    return buildResponse(404, { error: 'Transcript not found' });
  }
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: TRANSCRIPTS_BUCKET, Key: item.Item.s3Key }),
    );
    const text = await obj.Body.transformToString();
    return buildResponse(200, { transcript: item.Item, content: text });
  } catch {
    return buildResponse(200, { transcript: item.Item, content: null });
  }
}

async function deleteTranscript(districtId, videoId) {
  const item = await ddb.send(
    new GetCommand({ TableName: TRANSCRIPTS_TABLE, Key: { districtId, videoId } }),
  );
  // Delete S3 object if it exists
  if (item.Item?.s3Key) {
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: TRANSCRIPTS_BUCKET, Key: item.Item.s3Key }),
      );
    } catch {}
  }
  // Delete DynamoDB record
  await ddb.send(
    new DeleteCommand({ TableName: TRANSCRIPTS_TABLE, Key: { districtId, videoId } }),
  );

  // Sync KB to remove deleted transcript from vector index
  syncKnowledgeBase().catch((err) => console.warn('KB sync after delete failed:', err.message));

  return buildResponse(200, { districtId, videoId, deleted: true });
}

// ── Upload: presigned URL for direct S3 upload ───────────────────────────────

async function getUploadUrl(body) {
  const { districtId, title, fileName, contentType } = body;
  if (!districtId || !fileName) {
    return buildResponse(400, { error: 'districtId and fileName are required' });
  }

  const transcriptId = randomUUID().slice(0, 12);
  const ext = fileName.split('.').pop()?.toLowerCase() ?? 'txt';
  const isAudioVideo = ['mp3', 'mp4', 'wav', 'webm', 'm4a', 'ogg', 'flac', 'mpeg', 'avi', 'mov'].includes(ext);
  const isText = ['txt', 'vtt', 'srt'].includes(ext);

  if (!isAudioVideo && !isText) {
    return buildResponse(400, {
      error: 'Unsupported file type. Accepted: txt, vtt, srt, mp3, mp4, wav, webm, m4a, ogg, flac',
    });
  }

  // Audio/video goes to uploads/ (triggers transcript processor)
  // Text goes directly to transcripts/ (ready for KB ingestion)
  const s3Key = isAudioVideo
    ? `uploads/${districtId}/${transcriptId}.${ext}`
    : `transcripts/${districtId}/${transcriptId}.txt`;

  const metadata = {
    districtid: districtId,
    transcriptid: transcriptId,
    title: encodeURIComponent(title ?? fileName),
    filetype: ext,
    originalfilename: encodeURIComponent(fileName),
  };

  const presignedUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: TRANSCRIPTS_BUCKET,
      Key: s3Key,
      ContentType: contentType ?? 'application/octet-stream',
      Metadata: metadata,
    }),
    { expiresIn: 3600 },
  );

  // Create a pending transcript record
  const record = {
    districtId,
    videoId: transcriptId,
    title: title ?? fileName,
    status: isAudioVideo ? 'pending' : 'completed',
    s3Key,
    transcriptSource: isAudioVideo ? 'pending-transcribe' : 'manual-upload',
    fileType: ext,
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TRANSCRIPTS_TABLE, Item: record }));

  // If it's a text file, trigger KB sync after upload
  if (isText) {
    syncKnowledgeBase().catch((err) => console.warn('KB sync failed:', err.message));
  }

  return buildResponse(200, {
    uploadUrl: presignedUrl,
    s3Key,
    transcriptId,
    districtId,
    fileType: ext,
    willTranscribe: isAudioVideo,
  });
}

// ── Direct transcript text upload ────────────────────────────────────────────

async function uploadTranscriptText(body) {
  const { districtId, title, text } = body;
  if (!districtId || !text) {
    return buildResponse(400, { error: 'districtId and text are required' });
  }

  const transcriptId = randomUUID().slice(0, 12);
  const s3Key = `transcripts/${districtId}/${transcriptId}.txt`;

  const content = [
    `Title: ${title ?? 'Untitled'}`,
    `District: ${districtId}`,
    `Transcript ID: ${transcriptId}`,
    `Uploaded: ${new Date().toISOString()}`,
    `Transcript Source: manual-upload`,
    '',
    text,
  ].join('\n');

  await s3.send(
    new PutObjectCommand({
      Bucket: TRANSCRIPTS_BUCKET,
      Key: s3Key,
      Body: content,
      ContentType: 'text/plain',
      Metadata: { districtid: districtId, transcriptid: transcriptId },
    }),
  );

  const record = {
    districtId,
    videoId: transcriptId,
    title: title ?? 'Untitled',
    status: 'completed',
    s3Key,
    transcriptSource: 'manual-upload',
    transcriptLength: String(content.length),
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TRANSCRIPTS_TABLE, Item: record }));

  // Fire-and-forget KB sync — don't block the response
  syncKnowledgeBase().catch((err) => console.warn('KB sync failed:', err.message));

  return buildResponse(201, { transcript: record });
}

async function syncKnowledgeBase() {
  if (BEDROCK_KB_ID && BEDROCK_KB_DATA_SOURCE_ID) {
    try {
      await bedrockAgent.send(
        new StartIngestionJobCommand({
          knowledgeBaseId: BEDROCK_KB_ID,
          dataSourceId: BEDROCK_KB_DATA_SOURCE_ID,
        }),
      );
      console.log('KB sync triggered successfully');
    } catch (err) {
      console.error('KB sync failed:', err.message);
    }
  } else {
    console.warn('KB sync skipped — BEDROCK_KB_ID or BEDROCK_KB_DATA_SOURCE_ID not set');
  }
}

// ── List discovered videos (from YouTube monitor, not yet transcribed) ───────

async function listDiscoveredVideos(districtId) {
  let items;
  if (districtId) {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TRANSCRIPTS_TABLE,
        KeyConditionExpression: 'districtId = :d',
        ExpressionAttributeValues: { ':d': districtId },
      }),
    );
    items = result.Items ?? [];
  } else {
    const result = await ddb.send(new ScanCommand({ TableName: TRANSCRIPTS_TABLE }));
    items = result.Items ?? [];
  }

  // Filter to discovered videos (no transcript yet)
  const discovered = items
    .filter((i) => i.status === 'discovered')
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  return buildResponse(200, { videos: discovered });
}

// ── Analytics ────────────────────────────────────────────────────────────────

const QUERY_LOGS_TABLE = process.env.QUERY_LOGS_TABLE;

async function getAnalytics() {
  const result = await ddb.send(new ScanCommand({ TableName: QUERY_LOGS_TABLE }));
  const logs = result.Items ?? [];

  const totalQueries = logs.length;
  const answeredQueries = logs.filter((l) => l.answered).length;
  const unansweredQueries = totalQueries - answeredQueries;

  // Queries per district
  const districtCounts = {};
  for (const log of logs) {
    const d = log.districtId ?? 'all';
    districtCounts[d] = (districtCounts[d] ?? 0) + 1;
  }
  const topDistricts = Object.entries(districtCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([districtId, count]) => ({ districtId, count }));

  // Queries per day (last 30 days)
  const dailyCounts = {};
  for (const log of logs) {
    const date = log.date ?? log.timestamp?.split('T')[0] ?? 'unknown';
    dailyCounts[date] = (dailyCounts[date] ?? 0) + 1;
  }
  const dailyTrend = Object.entries(dailyCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([date, count]) => ({ date, count }));

  // Unique sessions
  const uniqueSessions = new Set(logs.map((l) => l.sessionId).filter(Boolean)).size;

  // Categorize queries into topic concerns
  const topicKeywords = {
    'Budget & Finance': ['budget', 'finance', 'fund', 'money', 'spending', 'cost', 'tax', 'bond', 'revenue', 'salary', 'pay', 'compensation'],
    'Curriculum & Academics': ['curriculum', 'academic', 'program', 'reading', 'math', 'science', 'test', 'score', 'grade', 'instruction', 'learning', 'education', 'student achievement'],
    'Safety & Security': ['safety', 'security', 'police', 'sro', 'threat', 'emergency', 'drill', 'violence', 'bully'],
    'Staffing & Personnel': ['teacher', 'staff', 'hire', 'hiring', 'principal', 'superintendent', 'resign', 'personnel', 'employee', 'contract'],
    'Facilities & Construction': ['facility', 'building', 'construction', 'renovation', 'repair', 'maintenance', 'campus', 'school building'],
    'Policy & Governance': ['policy', 'vote', 'approve', 'resolution', 'board', 'meeting', 'agenda', 'motion', 'governance'],
    'Community & Parents': ['parent', 'community', 'public comment', 'family', 'engagement', 'volunteer'],
    'Transportation': ['bus', 'transport', 'route', 'driver'],
    'Special Education': ['special education', 'iep', 'disability', 'accommodation', 'inclusion'],
    'Technology': ['technology', 'computer', 'device', 'internet', 'digital', 'online', 'ai'],
    'Health & Wellness': ['health', 'mental health', 'nurse', 'counselor', 'wellness', 'nutrition', 'lunch', 'meal', 'medical', 'covid', 'vaccine', 'illness', 'therapy'],
  };

  const concernCounts = {};
  const concernExamples = {};
  for (const log of logs) {
    if (!log.query) continue;
    const q = log.query.toLowerCase();
    let matched = false;
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some((kw) => q.includes(kw))) {
        concernCounts[topic] = (concernCounts[topic] ?? 0) + 1;
        if (!concernExamples[topic]) concernExamples[topic] = [];
        if (concernExamples[topic].length < 3) concernExamples[topic].push(log.query);
        matched = true;
        break;
      }
    }
    if (!matched) {
      concernCounts['General / Other'] = (concernCounts['General / Other'] ?? 0) + 1;
      if (!concernExamples['General / Other']) concernExamples['General / Other'] = [];
      if (concernExamples['General / Other'].length < 3) concernExamples['General / Other'].push(log.query);
    }
  }

  const topConcerns = Object.entries(concernCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([topic, count]) => ({
      topic,
      count,
      examples: concernExamples[topic] ?? [],
    }));

  // Average query/answer length
  const avgQueryLength = totalQueries > 0
    ? Math.round(logs.reduce((sum, l) => sum + (l.queryLength ?? 0), 0) / totalQueries)
    : 0;
  const avgAnswerLength = totalQueries > 0
    ? Math.round(logs.reduce((sum, l) => sum + (l.answerLength ?? 0), 0) / totalQueries)
    : 0;

  return buildResponse(200, {
    totalQueries,
    answeredQueries,
    unansweredQueries,
    answerRate: totalQueries > 0 ? Math.round((answeredQueries / totalQueries) * 100) : 0,
    uniqueSessions,
    avgQueryLength,
    avgAnswerLength,
    topDistricts,
    dailyTrend,
    topConcerns,
  });
}

// ── Trigger YouTube monitor scan ─────────────────────────────────────────────

async function triggerYoutubeScan() {
  if (!YOUTUBE_MONITOR_FN) {
    return buildResponse(500, { error: 'YouTube monitor function not configured' });
  }

  const resp = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: YOUTUBE_MONITOR_FN,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify({}),
    }),
  );

  const payload = JSON.parse(new TextDecoder().decode(resp.Payload));
  const body = JSON.parse(payload.body ?? '[]');

  const newCount = body.reduce((sum, d) => sum + (d.new ?? 0), 0);
  const errors = body.filter((d) => d.error);

  return buildResponse(200, {
    message: `Scan complete. Found ${newCount} new video(s) across ${body.length} districts.`,
    newVideos: newCount,
    errors: errors.length,
    details: body,
  });
}

// ── Router ───────────────────────────────────────────────────────────────────

export async function handler(event) {
  const method = event.httpMethod;
  const path = event.resource ?? event.path ?? '';
  const pathParams = event.pathParameters ?? {};

  try {
    // Districts
    if (path.includes('/admin/districts')) {
      if (method === 'GET') return listDistricts();
      if (method === 'POST') return createDistrict(JSON.parse(event.body ?? '{}'));
      if (method === 'PUT') return updateDistrict(pathParams.districtId, JSON.parse(event.body ?? '{}'));
      if (method === 'DELETE') return deleteDistrict(pathParams.districtId);
    }

    if (path === '/districts') return listDistricts();

    // Upload — get presigned URL for file upload
    if (path.includes('/admin/upload') && method === 'POST') {
      return getUploadUrl(JSON.parse(event.body ?? '{}'));
    }

    // Trigger YouTube channel scan
    if (path.includes('/admin/scan') && method === 'POST') {
      return triggerYoutubeScan();
    }

    // Analytics
    if (path.includes('/admin/analytics') && method === 'GET') {
      return getAnalytics();
    }

    // Discovered videos from YouTube monitor
    if (path.includes('/admin/videos')) {
      const districtId = pathParams.districtId;
      return listDiscoveredVideos(districtId);
    }

    // Transcripts
    if (path.includes('/admin/transcripts')) {
      if (method === 'POST') return uploadTranscriptText(JSON.parse(event.body ?? '{}'));
      if (method === 'DELETE') {
        const districtId = pathParams.districtId;
        const videoId = event.queryStringParameters?.videoId;
        if (districtId && videoId) return deleteTranscript(districtId, videoId);
        return buildResponse(400, { error: 'districtId and videoId are required' });
      }
      const districtId = pathParams.districtId;
      const videoId = event.queryStringParameters?.videoId;
      const view = event.queryStringParameters?.view;
      if (districtId && videoId && view === 'content') return getTranscriptContent(districtId, videoId);
      if (districtId && videoId) return getTranscriptUrl(districtId, videoId);
      return listTranscripts(districtId);
    }

    return buildResponse(404, { error: 'Not found' });
  } catch (err) {
    console.error('Admin API error:', err);
    return buildResponse(500, { error: 'Internal server error' });
  }
}
