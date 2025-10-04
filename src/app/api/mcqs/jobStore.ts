import type { McqValidatorSummary } from "@/lib/anthropic";

export interface TopicSummary {
  topic: string;
  description: string;
}

export interface JobPayload {
  chapterNumber: number;
  chapterTitle: string;
  topics: TopicSummary[];
  vectorStoreId: string;
  bookFingerprint?: string | null;
  classLevel: number;
  subject: {
    id: number;
    name: string;
  };
  syllabus: {
    id: number;
    name: string;
  };
}

export type JobStatus = "pending" | "processing" | "succeeded" | "failed";

export interface StoredMcqItem {
  bloom: string;
  difficulty: string;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  type: string;
  source_spans?: Array<{ page: number | null; text_snippet: string }>;
}

export interface StoredTopicMcqs {
  topic: string;
  items: StoredMcqItem[];
}

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  payload: JobPayload;
  createdAt: number;
  updatedAt: number;
  logs: string[];
  summary: McqValidatorSummary | null;
  resultCsv?: string;
  outputFilename?: string;
  error?: string;
  openAiUsage: TokenUsageTotals;
  anthropicUsage: TokenUsageTotals;
  generatedTopics?: StoredTopicMcqs[];
  allowValidationRetry?: boolean;
}

export type JobStore = Map<string, JobRecord>;

declare global {
  var __mcqJobStore: JobStore | undefined;
  var __mcqRetryValidation:
    | ((jobId: string, record: JobRecord) => Promise<void>)
    | undefined;
}

export function getJobStore(): JobStore {
  if (!globalThis.__mcqJobStore) {
    globalThis.__mcqJobStore = new Map();
  }
  return globalThis.__mcqJobStore;
}
