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
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { randomUUID } from 'crypto';

const region = process.env.AWS_REGION ?? 'us-east-1';
const ddbClient = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region });
const bedrockAgent = new BedrockAgentClient({ region });

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
  const result = await ddb.send(new ScanCommand({ TableName: DISTRICTS_TABLE }));
  return buildResponse(200, { districts: result.Items ?? [] });
}

async function createDistrict(body) {
  const { name, state, description } = body;
  if (!name) return buildResponse(400, { error: 'name is required' });

  const districtId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const item = {
    districtId,
    name,
    state: state ?? 'AZ',
    description: description ?? '',
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: DISTRICTS_TABLE, Item: item }));
  return buildResponse(201, { district: item });
}

async function updateDistrict(districtId, body) {
  const allowed = ['name', 'status', 'description', 'state'];
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
    new UpdateCommand({
      TableName: DISTRICTS_TABLE,
      Key: { districtId },
      UpdateExpression: 'SET #st = :inactive',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':inactive': 'inactive' },
    }),
  );
  return buildResponse(200, { districtId, status: 'inactive' });
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
    await syncKnowledgeBase();
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

  await syncKnowledgeBase();

  return buildResponse(201, { transcript: record });
}

async function syncKnowledgeBase() {
  if (BEDROCK_KB_ID && BEDROCK_KB_DATA_SOURCE_ID) {
    await bedrockAgent.send(
      new StartIngestionJobCommand({
        knowledgeBaseId: BEDROCK_KB_ID,
        dataSourceId: BEDROCK_KB_DATA_SOURCE_ID,
      }),
    );
  }
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

    // Transcripts
    if (path.includes('/admin/transcripts')) {
      if (method === 'POST') return uploadTranscriptText(JSON.parse(event.body ?? '{}'));
      const districtId = pathParams.districtId;
      const videoId = event.queryStringParameters?.videoId;
      if (districtId && videoId) return getTranscriptUrl(districtId, videoId);
      return listTranscripts(districtId);
    }

    return buildResponse(404, { error: 'Not found' });
  } catch (err) {
    console.error('Admin API error:', err);
    return buildResponse(500, { error: 'Internal server error' });
  }
}
