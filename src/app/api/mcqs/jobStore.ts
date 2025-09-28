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
}

export type JobStatus = "pending" | "processing" | "succeeded" | "failed";

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
}

export type JobStore = Map<string, JobRecord>;

declare global {
  // eslint-disable-next-line no-var
  var __mcqJobStore: JobStore | undefined;
}

export function getJobStore(): JobStore {
  if (!globalThis.__mcqJobStore) {
    globalThis.__mcqJobStore = new Map();
  }
  return globalThis.__mcqJobStore;
}
