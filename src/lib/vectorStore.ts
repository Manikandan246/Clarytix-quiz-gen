import type OpenAI from "openai";

export type VectorStoreFileSummary = {
  completed: string[];
  pending: string[];
  failed: string[];
};

/**
 * Collects the current file status counts for a vector store.
 */
export async function summarizeVectorStoreFiles(
  openai: OpenAI,
  vectorStoreId: string,
): Promise<VectorStoreFileSummary> {
  const summary: VectorStoreFileSummary = {
    completed: [],
    pending: [],
    failed: [],
  };

  const files = openai.vectorStores.files.list(vectorStoreId, { limit: 100 });

  // Iterate through any available pages—typically there will only be one.
  for await (const file of files) {
    switch (file.status) {
      case "completed":
        summary.completed.push(file.id);
        break;
      case "failed":
      case "cancelled":
        summary.failed.push(file.id);
        break;
      default:
        summary.pending.push(file.id);
        break;
    }
  }

  return summary;
}
