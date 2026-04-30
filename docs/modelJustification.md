# Model Justification

Rationale for AI model selection in The Beam School Board AI.

---

## Models Used

| Model | Purpose | Service |
|-------|---------|---------|
| **Amazon Titan Embed Text v2** | Document embedding for vector search | Bedrock Knowledge Base |
| **Anthropic Claude Haiku 4.5** | Answer generation from retrieved context | Bedrock RetrieveAndGenerate |

---

## Embedding Model: Amazon Titan Embed Text v2

### Why Titan Embed Text v2

- **Native AWS integration** — First-party model with direct S3 Vectors support, no external API calls
- **1024 dimensions** — Good balance between search quality and storage cost
- **Cost** — Significantly cheaper than third-party embedding models for the volume of documents we process
- **Latency** — Low latency for real-time vector search queries

### Alternatives Considered

| Model | Reason Not Selected |
|-------|-------------------|
| OpenAI text-embedding-3 | Requires external API calls, adds latency and cost |
| Cohere Embed v3 | Available on Bedrock but Titan has better S3 Vectors integration |
| Custom fine-tuned | Unnecessary — meeting transcripts are standard English text |

### Configuration

- **Dimensions**: 1024
- **Distance Metric**: Cosine similarity
- **Chunking**: Fixed-size, 512 tokens with 20% overlap

The 512-token chunk size was chosen because board meeting transcripts contain long, flowing dialogue. Smaller chunks would split mid-sentence too often. The 20% overlap ensures context isn't lost at chunk boundaries.

---

## Generation Model: Claude Haiku 4.5

### Why Claude Haiku 4.5

- **Speed** — Haiku is the fastest Claude model, important for interactive chat (sub-3-second responses)
- **Cost** — ~$0.001 per query, making it viable for a public-facing tool with potentially high volume
- **Quality** — Despite being the smallest Claude model, Haiku handles factual Q&A from provided context very well
- **Instruction following** — Reliably follows the system prompt to only answer from provided transcripts and cite sources
- **Cross-region inference** — Available via `us.anthropic.claude-haiku-4-5-20251001-v1:0` inference profile for better availability

### Alternatives Considered

| Model | Reason Not Selected |
|-------|-------------------|
| Claude Sonnet 3.5/4 | 5-10x more expensive per query, slower response times. Overkill for extractive Q&A from provided context |
| Claude Opus | 20x+ cost, much slower. Designed for complex reasoning, not needed here |
| GPT-4o | Requires OpenAI API integration, not native to Bedrock KB |
| GPT-4o-mini | Similar cost/speed to Haiku but requires external API |
| Llama 3 | Available on Bedrock but weaker instruction following for RAG tasks |
| Amazon Titan Text | Weaker at nuanced Q&A and citation generation compared to Claude |

### Why Not a Larger Model?

The chatbot's task is **extractive Q&A** — finding relevant passages in transcripts and summarizing them. This doesn't require advanced reasoning, creative writing, or complex multi-step logic. Haiku excels at:

- Reading provided context and answering factually
- Following system prompt constraints ("only answer from transcripts")
- Generating concise, well-structured responses
- Citing specific meeting details (district, date)

A larger model would produce marginally better prose but at significantly higher cost and latency, with no meaningful improvement in answer accuracy for this use case.

---

## RAG Configuration

### Retrieval Settings

- **Number of results**: 5 chunks retrieved per query
- **Search method**: Vector similarity (cosine) on S3 Vectors

5 results provides enough context for most questions while keeping the prompt size manageable. Board meeting transcripts are verbose — 5 chunks of 512 tokens each gives the model ~2,500 tokens of context.

### Generation Settings

- **Max tokens**: 1024 (response length)
- **Temperature**: 0.1 (low creativity, high factual accuracy)

Low temperature is critical for a journalism tool — we want factual, reproducible answers, not creative interpretations.

### District Scoping

Since S3 Vectors doesn't support metadata filtering, district scoping is achieved through:

1. **Query augmentation** — Prepending `[District: {id}]` to the search query
2. **Document structure** — Each transcript includes `District: {id}` in its header
3. **System prompt** — Instructs the model to only use transcripts from the specified district

This approach works because the embedding model captures the district identifier in the vector representation, so vector similarity naturally ranks same-district chunks higher.

---

## Cost Projections

### Per-Query Cost

| Component | Cost |
|-----------|------|
| Titan Embed (query embedding) | ~$0.0001 |
| S3 Vectors search | ~$0.0001 |
| Claude Haiku generation | ~$0.001 |
| **Total per query** | **~$0.0012** |

### Monthly Estimates

| Usage Level | Queries/Month | Monthly Cost |
|-------------|---------------|--------------|
| Low (testing) | 100 | ~$0.12 |
| Medium (internal use) | 1,000 | ~$1.20 |
| High (public launch) | 10,000 | ~$12.00 |

### Transcript Processing Cost

| Method | Cost |
|--------|------|
| Manual text paste | Free |
| AWS Transcribe (2-hour meeting) | ~$2.88 |
| KB ingestion (per sync) | ~$0.01 |

---

## Future Considerations

### Model Upgrades

As newer Claude models are released, upgrading is a single line change in the CDK stack. The RAG architecture is model-agnostic — any Bedrock-supported model works.

### Fine-Tuning

If query patterns become predictable (e.g., most users ask about budgets), a fine-tuned model could improve answer quality. However, the current RAG approach with Haiku is sufficient for the extractive Q&A use case.

### Multi-Modal

Future versions could support image/document analysis from meeting agendas and presentations using Claude's vision capabilities. This would require changes to the KB data source configuration.
