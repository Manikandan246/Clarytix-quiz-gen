import { NextResponse } from "next/server";
import { getJobStore, type JobRecord } from "../jobStore";

export const runtime = "nodejs";

function getRetryValidation(): (jobId: string, record: JobRecord) => Promise<void> {
  const handler = globalThis.__mcqRetryValidation;
  if (!handler) {
    throw new Error("Validation retry handler is unavailable.");
  }
  return handler;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => null)) as { jobId?: string } | null;

    if (!payload || typeof payload.jobId !== "string" || payload.jobId.trim().length === 0) {
      return NextResponse.json({ error: "jobId is required." }, { status: 400 });
    }

    const jobId = payload.jobId.trim();
    const jobStore = getJobStore();
    const record = jobStore.get(jobId);

    if (!record) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    if (!record.generatedTopics || record.generatedTopics.length === 0) {
      return NextResponse.json({ error: "No generated MCQs available for retry." }, { status: 400 });
    }

    await import("../route");

    const retryValidation = getRetryValidation();
    await retryValidation(jobId, record);

    return NextResponse.json({
      jobId: record.id,
      status: record.status,
      error: record.error ?? null,
      allowValidationRetry: Boolean(record.allowValidationRetry),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to retry validation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
