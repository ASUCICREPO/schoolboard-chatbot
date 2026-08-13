import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const region = process.env.AWS_REGION ?? 'us-east-1';
const agentRuntime = new BedrockAgentRuntimeClient({ region }); // KB retrieval
const bedrockLlm = new BedrockRuntimeClient({ region });        // text generation
const ddbClient = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(ddbClient);

const QUERY_LOGS_TABLE = process.env.QUERY_LOGS_TABLE;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const BEDROCK_KB_ID = process.env.BEDROCK_KB_ID;

const NUM_RESULTS = 25;
const MAX_HISTORY_MESSAGES = 10; // last ~5 exchanges threaded into the model

const SYSTEM_PROMPT = `You are a helpful research assistant for The Beam, an Arizona journalism outlet covering local school districts. Your sole purpose is to help journalists and citizens understand what happened at public school board meetings.

You answer questions about school board meetings based solely on the transcript excerpts provided in the search results below. These are official public meeting records.

Rules:
- Always answer using only the provided transcript excerpts
- You are given multiple excerpts from the same meeting; synthesize across all of them to give a complete answer
- This is a multi-turn conversation; use the prior messages to resolve references like "it", "that meeting", or "they"
- Be factual and cite specific meeting details (district, date) when possible
- If the information is not in the transcripts, say "I don't have information about that in the available transcripts"
- Do not add disclaimers that the transcript or excerpt is "limited" or "incomplete" — answer with the substance you have
- Keep responses concise and relevant
- Do not refuse to answer questions about public school board meeting content`;

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

// Normalize client-supplied history into a clean alternating user/assistant list
// that Converse accepts: starts with 'user', strictly alternates, ends with
// 'assistant' (so the current user turn can be appended without two users in a row).
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const m of history.slice(-MAX_HISTORY_MESSAGES)) {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
    const text = typeof m?.content === 'string' ? m.content.trim() : '';
    if (!role || !text) continue;
    const expected = out.length % 2 === 0 ? 'user' : 'assistant';
    if (role !== expected) continue; // drop anything that breaks strict alternation
    out.push({ role, content: [{ text: text.slice(0, 4000) }] });
  }
  // Must end on assistant so the appended current user turn keeps alternation
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

async function logQuery(query, districtId, answer, sessionId) {
  const logId = randomUUID();
  const now = new Date();
  try {
    await ddb.send(
      new PutCommand({
        TableName: QUERY_LOGS_TABLE,
        Item: {
          logId,
          sessionId,
          districtId: districtId ?? 'all',
          query: query.slice(0, 500),
          queryLength: query.length,
          answerLength: answer?.length ?? 0,
          answered: answer && !answer.includes("don't have information") && !answer.includes('unable to assist'),
          timestamp: now.toISOString(),
          date: now.toISOString().split('T')[0],
        },
      }),
    );
  } catch (err) {
    console.error('Failed to log query:', err.message);
  }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return buildResponse(200, {});
  }

  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return buildResponse(400, { error: 'Invalid JSON body' });
  }

  const { query, districtId, sessionId, history } = body;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return buildResponse(400, { error: 'query is required' });
  }
  if (query.length > 2000) {
    return buildResponse(400, { error: 'query too long (max 2000 characters)' });
  }
  if (!BEDROCK_KB_ID) {
    return buildResponse(503, { error: 'Knowledge base not configured' });
  }

  // Keep a stable conversation id for query-log grouping (memory now comes from `history`)
  const convId = sessionId ?? randomUUID();
  const priorMessages = normalizeHistory(history);

  try {
    // Build the retrieval query. For follow-ups, fold in the previous user turn so
    // references like "it" / "that meeting" still fetch the right transcripts.
    const lastUserTurn = [...priorMessages].reverse().find((m) => m.role === 'user');
    const prevContext = lastUserTurn ? `${lastUserTurn.content[0].text} ` : '';
    const retrievalText = districtId
      ? `[District: ${districtId}] ${prevContext}${query.trim()}`
      : `${prevContext}${query.trim()}`;

    // 1) Retrieve district-scoped chunks from the Knowledge Base
    const retrieveRes = await agentRuntime.send(
      new RetrieveCommand({
        knowledgeBaseId: BEDROCK_KB_ID,
        retrievalQuery: { text: retrievalText },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: NUM_RESULTS,
            ...(districtId ? { filter: { equals: { key: 'districtId', value: districtId } } } : {}),
          },
        },
      }),
    );
    const chunks = retrieveRes.retrievalResults ?? [];
    const context = chunks.map((c, i) => `[${i + 1}] ${c.content?.text ?? ''}`).join('\n\n');

    // 2) Generate with Converse, threading the full conversation history ourselves
    const messages = [
      ...priorMessages,
      { role: 'user', content: [{ text: `Transcript excerpts:\n\n${context}\n\nQuestion: ${query.trim()}` }] },
    ];
    const converseRes = await bedrockLlm.send(
      new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages,
        inferenceConfig: { maxTokens: 1024, temperature: 0.1 },
      }),
    );
    const answer = converseRes.output?.message?.content?.[0]?.text ?? '';

    const citations = chunks
      .map((c) => ({
        content: c.content?.text?.slice(0, 200),
        location: c.location?.s3Location?.uri,
        metadata: c.metadata,
      }))
      .slice(0, 3);

    await logQuery(query, districtId, answer, convId);

    return buildResponse(200, {
      answer,
      sessionId: convId,
      citations,
    });
  } catch (err) {
    console.error('Bedrock error:', err.name, err.message);
    if (err.name === 'AccessDeniedException' || err.name === 'ResourceNotFoundException') {
      return buildResponse(502, { error: 'AI model access is not enabled for this region. Check Bedrock model access.' });
    }
    if (err.name === 'ValidationException') {
      return buildResponse(400, { error: 'Request rejected by Bedrock (validation).' });
    }
    if (err.name === 'ThrottlingException') {
      return buildResponse(429, { error: 'The service is busy. Please try again in a moment.' });
    }
    return buildResponse(500, { error: 'Failed to generate answer. Please try again.' });
  }
}
