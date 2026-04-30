import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';

const region = process.env.AWS_REGION ?? 'us-east-1';
const ddbClient = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region });
const bedrockAgent = new BedrockAgentClient({ region });
const transcribe = new TranscribeClient({ region });

const TRANSCRIPTS_BUCKET = process.env.TRANSCRIPTS_BUCKET;
const TRANSCRIPTS_TABLE = process.env.TRANSCRIPTS_TABLE;
const BEDROCK_KB_ID = process.env.BEDROCK_KB_ID;
const BEDROCK_KB_DATA_SOURCE_ID = process.env.BEDROCK_KB_DATA_SOURCE_ID;

const TRANSCRIBE_POLL_INTERVAL_MS = 10_000;
const TRANSCRIBE_MAX_WAIT_MS = 14 * 60 * 1000;

// ── Run AWS Transcribe on an uploaded audio/video file ───────────────────────

async function runTranscribeJob(s3Key) {
  const ext = s3Key.split('.').pop()?.toLowerCase() ?? 'mp4';
  const mediaFormatMap = {
    mp3: 'mp3', mp4: 'mp4', wav: 'wav', webm: 'webm',
    m4a: 'mp4', ogg: 'ogg', flac: 'flac', mpeg: 'mp4',
    avi: 'mp4', mov: 'mp4',
  };
  const mediaFormat = mediaFormatMap[ext] ?? 'mp4';
  const jobName = `schoolbot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await transcribe.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: 'en-US',
      MediaFormat: mediaFormat,
      Media: {
        MediaFileUri: `s3://${TRANSCRIPTS_BUCKET}/${s3Key}`,
      },
      OutputBucketName: TRANSCRIPTS_BUCKET,
      OutputKey: `transcribe-output/${jobName}.json`,
    }),
  );

  const deadline = Date.now() + TRANSCRIBE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, TRANSCRIBE_POLL_INTERVAL_MS));

    const statusResp = await transcribe.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
    );
    const status = statusResp.TranscriptionJob?.TranscriptionJobStatus;

    if (status === 'COMPLETED') {
      return `transcribe-output/${jobName}.json`;
    }
    if (status === 'FAILED') {
      const reason = statusResp.TranscriptionJob?.FailureReason ?? 'unknown';
      throw new Error(`Transcribe job failed: ${reason}`);
    }
  }

  throw new Error(`Transcribe job timed out after ${TRANSCRIBE_MAX_WAIT_MS / 1000}s`);
}

async function getTranscribeText(outputKey) {
  const resp = await s3.send(
    new GetObjectCommand({ Bucket: TRANSCRIPTS_BUCKET, Key: outputKey }),
  );
  const body = await resp.Body.transformToString();
  const data = JSON.parse(body);
  return data?.results?.transcripts?.[0]?.transcript ?? '';
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

async function updateTranscriptStatus(districtId, videoId, status, extra = {}) {
  const extraKeys = Object.keys(extra);
  await ddb.send(
    new UpdateCommand({
      TableName: TRANSCRIPTS_TABLE,
      Key: { districtId, videoId },
      UpdateExpression:
        'SET #st = :status, updatedAt = :updatedAt' +
        (extraKeys.length ? ', ' + extraKeys.map((k) => `#${k} = :${k}`).join(', ') : ''),
      ExpressionAttributeNames: {
        '#st': 'status',
        ...Object.fromEntries(extraKeys.map((k) => [`#${k}`, k])),
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':updatedAt': new Date().toISOString(),
        ...Object.fromEntries(extraKeys.map((k) => [`:${k}`, extra[k]])),
      },
    }),
  );
}

// ── Main handler (S3 event triggered) ────────────────────────────────────────

export async function handler(event) {
  for (const record of event.Records) {
    const s3Key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    console.log(`Processing uploaded file: ${s3Key}`);

    // Extract metadata from S3 object
    const headResp = await s3.send(
      new GetObjectCommand({ Bucket: TRANSCRIPTS_BUCKET, Key: s3Key }),
    );
    const metadata = headResp.Metadata ?? {};
    const districtId = metadata.districtid;
    const transcriptId = metadata.transcriptid;
    const title = decodeURIComponent(metadata.title ?? 'Untitled');

    if (!districtId || !transcriptId) {
      console.error(`Missing metadata on ${s3Key}, skipping`);
      continue;
    }

    try {
      await updateTranscriptStatus(districtId, transcriptId, 'transcribing');

      // Run Transcribe
      console.log(`Starting Transcribe for ${s3Key}`);
      const outputKey = await runTranscribeJob(s3Key);
      const transcriptText = await getTranscribeText(outputKey);

      if (!transcriptText) {
        await updateTranscriptStatus(districtId, transcriptId, 'failed', {
          errorMessage: 'Transcribe returned empty result',
        });
        continue;
      }

      // Store transcript text to S3
      const transcriptS3Key = `transcripts/${districtId}/${transcriptId}.txt`;
      const content = [
        `Title: ${title}`,
        `District: ${districtId}`,
        `Transcript ID: ${transcriptId}`,
        `Transcribed: ${new Date().toISOString()}`,
        `Transcript Source: amazon-transcribe`,
        '',
        transcriptText,
      ].join('\n');

      await s3.send(
        new PutObjectCommand({
          Bucket: TRANSCRIPTS_BUCKET,
          Key: transcriptS3Key,
          Body: content,
          ContentType: 'text/plain',
          Metadata: { districtid: districtId, transcriptid: transcriptId },
        }),
      );

      await updateTranscriptStatus(districtId, transcriptId, 'completed', {
        s3Key: transcriptS3Key,
        transcriptSource: 'amazon-transcribe',
        transcriptLength: String(content.length),
      });

      // Clean up: remove uploaded audio and transcribe output
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: TRANSCRIPTS_BUCKET, Key: s3Key }));
        await s3.send(new DeleteObjectCommand({ Bucket: TRANSCRIPTS_BUCKET, Key: outputKey }));
      } catch {}

      // Sync Bedrock KB
      if (BEDROCK_KB_ID && BEDROCK_KB_DATA_SOURCE_ID) {
        await bedrockAgent.send(
          new StartIngestionJobCommand({
            knowledgeBaseId: BEDROCK_KB_ID,
            dataSourceId: BEDROCK_KB_DATA_SOURCE_ID,
          }),
        );
        console.log(`Triggered Bedrock KB sync for ${districtId}`);
      }

      console.log(`Completed transcript for ${districtId}/${transcriptId}: ${content.length} chars`);
    } catch (err) {
      console.error(`Error processing ${s3Key}:`, err);
      await updateTranscriptStatus(districtId, transcriptId, 'failed', {
        errorMessage: err.message,
      });
    }
  }
}
