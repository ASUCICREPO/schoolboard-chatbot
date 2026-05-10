import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DISTRICTS } from './districts.mjs';

const region = process.env.AWS_REGION ?? 'us-east-1';
const ddbClient = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new SecretsManagerClient({ region });

const TRANSCRIPTS_TABLE = process.env.TRANSCRIPTS_TABLE;
const DISTRICTS_TABLE = process.env.DISTRICTS_TABLE;
const YOUTUBE_API_KEY_SECRET = process.env.YOUTUBE_API_KEY_SECRET ?? 'schoolbot/youtube-api-key';
const MAX_RESULTS = 3;

const YT_API = 'https://www.googleapis.com/youtube/v3';

// Cache the API key across invocations
let _youtubeApiKey = null;
let YOUTUBE_API_KEY = '';

async function getYouTubeApiKey() {
  if (_youtubeApiKey) return _youtubeApiKey;
  const resp = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: YOUTUBE_API_KEY_SECRET }),
  );
  _youtubeApiKey = resp.SecretString;
  YOUTUBE_API_KEY = _youtubeApiKey;
  return _youtubeApiKey;
}

// ── Resolve YouTube URL → uploads playlist ID ────────────────────────────────
// Every channel has a hidden "uploads" playlist: channel UC... → playlist UU...
// Explicit playlist URLs are used directly.

async function resolvePlaylistId(youtubeUrl) {
  const url = new URL(youtubeUrl);

  // Explicit playlist URL: /playlist?list=PLxxx
  const listParam = url.searchParams.get('list');
  if (listParam) return listParam;

  // Direct channel ID: /channel/UCxxxxxxx → UUxxxxxxx
  const channelMatch = url.pathname.match(/\/channel\/(UC[\w-]+)/);
  if (channelMatch) return channelMatch[1].replace(/^UC/, 'UU');

  // Handle: /@handle → resolve via API → UU...
  const handleMatch = url.pathname.match(/\/@([\w.-]+)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    const apiUrl = `${YT_API}/channels?key=${YOUTUBE_API_KEY}&forHandle=${handle}&part=id`;
    const resp = await fetch(apiUrl);
    if (resp.ok) {
      const data = await resp.json();
      const channelId = data.items?.[0]?.id;
      if (channelId) return channelId.replace(/^UC/, 'UU');
      console.warn(`forHandle returned no items for handle=${handle}`);
    } else {
      console.warn(`forHandle API error for handle=${handle}: ${resp.status}`);
    }
  }

  // Vanity URL: /c/name or /user/name → resolve via search
  const vanityMatch = url.pathname.match(/\/(?:c|user)\/([\w.-]+)/);
  if (vanityMatch) {
    const resp = await fetch(
      `${YT_API}/search?key=${YOUTUBE_API_KEY}&q=${vanityMatch[1]}&type=channel&part=id&maxResults=1`,
    );
    if (resp.ok) {
      const data = await resp.json();
      const channelId = data.items?.[0]?.id?.channelId;
      if (channelId) return channelId.replace(/^UC/, 'UU');
    }
  }

  return null;
}

// ── Fetch recent videos from a playlist (1 quota unit) ───────────────────────

async function fetchPlaylistVideos(playlistId) {
  // Fetch more than MAX_RESULTS to handle playlists where newest isn't first
  const fetchCount = Math.max(MAX_RESULTS * 3, 10);
  const resp = await fetch(
    `${YT_API}/playlistItems?key=${YOUTUBE_API_KEY}&playlistId=${playlistId}&part=snippet&maxResults=${fetchCount}`,
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`YouTube API ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  const videos = (data.items ?? []).map((item) => ({
    videoId: item.snippet.resourceId?.videoId,
    title: item.snippet.title,
    publishedAt: item.snippet.publishedAt,
    thumbnail: item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url ?? '',
    description: (item.snippet.description ?? '').slice(0, 200),
  })).filter((v) => v.videoId);

  // Sort by publishedAt descending (newest first) and take top MAX_RESULTS
  return videos
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .slice(0, MAX_RESULTS);
}

// ── Filter out upcoming/live videos using videos.list (1 quota unit) ─────────

async function filterCompletedVideos(videos) {
  if (videos.length === 0) return [];

  const ids = videos.map((v) => v.videoId).join(',');
  const resp = await fetch(
    `${YT_API}/videos?key=${YOUTUBE_API_KEY}&id=${ids}&part=liveStreamingDetails`,
  );
  if (!resp.ok) return videos; // If the check fails, keep all videos

  const data = await resp.json();
  const liveStatus = new Map();
  for (const item of data.items ?? []) {
    const details = item.liveStreamingDetails;
    if (!details) {
      liveStatus.set(item.id, 'none'); // Regular upload, not a stream
    } else if (details.actualEndTime) {
      liveStatus.set(item.id, 'completed'); // Stream that has ended
    } else if (details.actualStartTime) {
      liveStatus.set(item.id, 'live'); // Currently streaming
    } else {
      liveStatus.set(item.id, 'upcoming'); // Scheduled, not started
    }
  }

  return videos.filter((v) => {
    const status = liveStatus.get(v.videoId) ?? 'none';

    // Always skip live and upcoming
    if (status === 'live' || status === 'upcoming') {
      console.log(`Skipping ${v.videoId} (${v.title}) — ${status}`);
      return false;
    }

    return true;
  });
}

// ── Check which videos already exist in DynamoDB ─────────────────────────────

async function getExistingVideos(districtId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TRANSCRIPTS_TABLE,
      KeyConditionExpression: 'districtId = :d',
      ExpressionAttributeValues: { ':d': districtId },
      ProjectionExpression: 'videoId, publishedAt',
    }),
  );
  const items = result.Items ?? [];
  const ids = new Set(items.map((i) => i.videoId));
  const newestDate = items
    .map((i) => i.publishedAt)
    .filter(Boolean)
    .sort()
    .reverse()[0] ?? null;
  return { ids, newestDate };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handler() {
  await getYouTubeApiKey();
  if (!YOUTUBE_API_KEY) {
    throw new Error('YouTube API key not found in Secrets Manager');
  }

  // Seed districts table with the hardcoded list (idempotent)
  if (DISTRICTS_TABLE) {
    for (const district of DISTRICTS) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: DISTRICTS_TABLE,
            Item: {
              districtId: district.id,
              name: district.name,
              youtubeUrl: district.youtubeUrl,
              status: 'active',
              updatedAt: new Date().toISOString(),
            },
            ConditionExpression: 'attribute_not_exists(districtId)',
          }),
        );
      } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
      }
    }
  }

  const results = [];

  for (const district of DISTRICTS) {
    const { id: districtId, youtubeUrl } = district;

    if (!youtubeUrl) {
      results.push({ districtId, skipped: 'no URL' });
      continue;
    }

    try {
      const playlistId = await resolvePlaylistId(youtubeUrl);
      if (!playlistId) {
        console.warn(`Could not resolve playlist for ${districtId}: ${youtubeUrl}`);
        results.push({ districtId, error: 'Could not resolve playlist ID' });
        continue;
      }

      const videos = await fetchPlaylistVideos(playlistId);
      const { ids: existingIds, newestDate } = await getExistingVideos(districtId);

      const newVideos = videos.filter((v) => {
        if (existingIds.has(v.videoId)) return false;
        if (newestDate && v.publishedAt && v.publishedAt < newestDate) return false;
        return true;
      });

      // Filter out upcoming/live videos (1 quota unit for all IDs)
      const readyVideos = await filterCompletedVideos(newVideos);

      for (const video of readyVideos) {
        try {
          await ddb.send(
            new PutCommand({
              TableName: TRANSCRIPTS_TABLE,
              Item: {
                districtId,
                videoId: video.videoId,
                title: video.title,
                publishedAt: video.publishedAt,
                thumbnail: video.thumbnail,
                description: video.description,
                status: 'discovered',
                createdAt: new Date().toISOString(),
              },
              ConditionExpression: 'attribute_not_exists(videoId)',
            }),
          );
        } catch (err) {
          if (err.name !== 'ConditionalCheckFailedException') throw err;
        }
      }

      // Clean up: keep only the 3 most recent discovered videos per district
      const allItems = await ddb.send(
        new QueryCommand({
          TableName: TRANSCRIPTS_TABLE,
          KeyConditionExpression: 'districtId = :d',
          ExpressionAttributeValues: { ':d': districtId },
        }),
      );
      const discoveredItems = (allItems.Items ?? [])
        .filter((i) => i.status === 'discovered')
        .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

      // Delete anything beyond the top 3
      for (const old of discoveredItems.slice(MAX_RESULTS)) {
        await ddb.send(
          new DeleteCommand({
            TableName: TRANSCRIPTS_TABLE,
            Key: { districtId, videoId: old.videoId },
          }),
        );
      }

      results.push({ districtId, total: videos.length, new: readyVideos.length });
    } catch (err) {
      console.error(`Error for ${districtId}:`, err.message);
      results.push({ districtId, error: err.message });
    }
  }

  console.log('Monitor results:', JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify(results) };
}
