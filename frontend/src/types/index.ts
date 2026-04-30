export interface District {
  districtId: string;
  name: string;
  youtubeChannelId?: string;
  youtubeUrl?: string;
  state: string;
  description?: string;
  status: "active" | "inactive";
  transcriptCount?: number;
  lastUpdated?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface Transcript {
  districtId: string;
  videoId: string;
  title: string;
  publishedAt?: string;
  status: "discovered" | "pending" | "transcribing" | "completed" | "failed" | "unavailable";
  s3Key?: string;
  thumbnail?: string;
  description?: string;
  transcriptSource?: string;
  transcriptLength?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  timestamp: Date;
}

export interface Citation {
  content?: string;
  location?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatRequest {
  query: string;
  districtId?: string;
  sessionId?: string;
}

export interface ChatResponse {
  answer: string;
  sessionId: string;
  citations?: Citation[];
  error?: string;
}
