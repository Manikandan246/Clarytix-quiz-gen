import { NextRequest, NextResponse } from "next/server";
import { getJobStore } from "../jobStore";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");

  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId parameter." }, { status: 400 });
  }

  const jobStore = getJobStore();
  const record = jobStore.get(jobId);

  if (!record) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  return NextResponse.json({
    jobId: record.id,
    status: record.status,
    logs: record.logs,
    summary: record.summary,
    error: record.error ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    openAiUsage: record.openAiUsage,
    anthropicUsage: record.anthropicUsage,
    allowValidationRetry: Boolean(record.allowValidationRetry),
    allowPersistenceRetry: Boolean(record.allowPersistenceRetry),
    outputFilename: record.outputFilename ?? null,
  });
}
