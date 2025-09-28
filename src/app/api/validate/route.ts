import { NextRequest, NextResponse } from "next/server";
import { validateTopics, type TopicValidationPayload } from "@/lib/anthropic";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { items?: TopicValidationPayload[] };
    const items = body.items;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "Request must include a non-empty items array." }, { status: 400 });
    }

    for (const item of items) {
      if (!item || typeof item !== "object") {
        return NextResponse.json({ error: "Each item must be an object." }, { status: 400 });
      }

      if (typeof item.topic !== "string" || item.topic.trim().length === 0) {
        return NextResponse.json({ error: "Each payload requires a topic." }, { status: 400 });
      }

      if (!Array.isArray(item.questions) || item.questions.length === 0) {
        return NextResponse.json({ error: "Each payload requires a non-empty questions array." }, { status: 400 });
      }

      for (const question of item.questions) {
        if (typeof question.stem !== "string" || typeof question.explanation !== "string") {
          return NextResponse.json({ error: "Each question requires stem and explanation." }, { status: 400 });
        }

        if (!Array.isArray(question.options) || question.options.length !== 4) {
          return NextResponse.json({ error: "Each question must include exactly four options." }, { status: 400 });
        }

        if (typeof question.correctLetter !== "string" || !["A", "B", "C", "D"].includes(question.correctLetter)) {
          return NextResponse.json({ error: "correctLetter must be one of A, B, C, D." }, { status: 400 });
        }
      }
    }

    const summary = await validateTopics(items);
    return NextResponse.json(summary);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to validate MCQs at this time.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
