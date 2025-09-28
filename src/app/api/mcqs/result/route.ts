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

  if (record.status !== "succeeded" || !record.resultCsv) {
    return NextResponse.json({ error: "Job is not ready." }, { status: 409 });
  }

  return new NextResponse(record.resultCsv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${record.outputFilename ?? "mcqs.csv"}"`,
    },
  });
}
