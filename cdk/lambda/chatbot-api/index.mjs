import { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const region = process.env.AWS_REGION ?? 'us-east-1';
const bedrockRuntime = new BedrockAgentRuntimeClient({ region });
const ddbClient = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(ddbClient);

const QUERY_LOGS_TABLE = process.env.QUERY_LOGS_TABLE;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-haiku-4-5-20251001-v1:0';
const BEDROCK_KB_ID = process.env.BEDROCK_KB_ID;

const SYSTEM_PROMPT = `You are a helpful research assistant for The Beam, an Arizona journalism outlet covering local school districts. Your sole purpose is to help journalists and citizens understand what happened at public school board meetings.

You answer questions about school board meetings based solely on the transcript excerpts provided in the search results below. These are official public meeting records.

Rules:
- Always answer using only the provided transcript excerpts
- You are given multiple excerpts from the same meeting; synthesize across all of them to give a complete answer
- Be factual and cite specific meeting details (district, date) when possible
- If the query specifies a district (shown in brackets like [District: xxx]), only use transcripts from that specific district
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

// Bedrock returns this canned string when its managed RAG (especially session-based
// query reformulation on a follow-up turn) can't ground an answer. The model can often
// still answer the same question standalone, so we detect it and retry without the session.
const REFUSAL_PATTERN = /unable to assist|cannot assist|can't assist|i cannot help|i can't help/i;

function buildRagCommand(searchQuery, districtId, sessionId) {
  return new RetrieveAndGenerateCommand({
    input: { text: searchQuery },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: BEDROCK_KB_ID,
        modelArn: BEDROCK_MODEL_ID.startsWith('arn:')
          ? BEDROCK_MODEL_ID
          : BEDROCK_MODEL_ID.match(/^(us\.|eu\.|ap\.|global\.)/)
            ? `arn:aws:bedrock:${region}:${process.env.AWS_ACCOUNT_ID}:inference-profile/${BEDROCK_MODEL_ID}`
            : `arn:aws:bedrock:${region}::foundation-model/${BEDROCK_MODEL_ID}`,
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 25,
            // Hard-scope retrieval to the requested district so all chunks come
            // from that district's transcripts (no cross-district leakage).
            ...(districtId ? { filter: { equals: { key: 'districtId', value: districtId } } } : {}),
          },
        },
        generationConfiguration: {
          promptTemplate: {
            textPromptTemplate: `${SYSTEM_PROMPT}\n\n$search_results$\n\nHuman: $query$\nAssistant:`,
          },
          inferenceConfig: {
            textInferenceConfig: {
              maxTokens: 1024,
              temperature: 0.1,
            },
          },
        },
      },
    },
    ...(sessionId ? { sessionId } : {}),
  });
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
          answered: answer && !answer.includes("don't have information") && !answer.includes("unable to assist"),
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

  const { query, districtId, sessionId } = body;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return buildResponse(400, { error: 'query is required' });
  }

  if (query.length > 2000) {
    return buildResponse(400, { error: 'query too long (max 2000 characters)' });
  }

  const kbId = BEDROCK_KB_ID;
  if (!kbId) {
    return buildResponse(503, { error: 'Knowledge base not configured' });
  }

  try {
    const sid = sessionId ?? undefined;

    // Prepend district context to query for better vector search relevance
    const searchQuery = districtId
      ? `[District: ${districtId}] ${query.trim()}`
      : query.trim();

    let response = await bedrockRuntime.send(buildRagCommand(searchQuery, districtId, sid));
    let answer = response.output?.text ?? '';

    // If a follow-up turn hit Bedrock's canned refusal, retry once as a fresh
    // standalone query (no session) — the question is usually answerable on its own.
    if (sid && REFUSAL_PATTERN.test(answer)) {
      console.log('Session response refused; retrying without session');
      const retry = await bedrockRuntime.send(buildRagCommand(searchQuery, districtId, undefined));
      const retryAnswer = retry.output?.text ?? '';
      if (retryAnswer && !REFUSAL_PATTERN.test(retryAnswer)) {
        response = retry;
        answer = retryAnswer;
      }
    }

    const newSessionId = response.sessionId;

    const citations = (response.citations ?? []).flatMap((c) =>
      (c.retrievedReferences ?? []).map((ref) => ({
        content: ref.content?.text?.slice(0, 200),
        location: ref.location?.s3Location?.uri,
        metadata: ref.metadata,
      })),
    );

    await logQuery(query, districtId, answer, newSessionId);

    return buildResponse(200, {
      answer,
      sessionId: newSessionId,
      citations: citations.slice(0, 3),
    });
  } catch (err) {
    console.error('Bedrock RAG error:', err);
    if (err.name === 'ValidationException') {
      return buildResponse(400, { error: 'Invalid query format' });
    }
    return buildResponse(500, { error: 'Failed to generate answer. Please try again.' });
  }
}
