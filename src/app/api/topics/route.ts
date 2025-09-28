import { Readable } from "node:stream";
import { type NextRequest, NextResponse } from "next/server";
import { toFile } from "openai/uploads";
import { getOpenAIClient } from "@/lib/openai";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MODEL = "gpt-4.1";

const MAX_FILE_RETENTION_MS = 60 * 60 * 1000; // keep cached uploads for 1 hour.

type CachedStore = {
  uploadedAt: number;
  vectorStoreId: string;
};

const storeCache: Map<string, CachedStore> = new Map();

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const pdf = formData.get("pdf");
    const chapterNumber = formData.get("chapterNumber");
    const chapterTitle = formData.get("chapterTitle");
    const bookIdentifier = formData.get("bookFingerprint");

    if (!pdf || !(pdf instanceof Blob)) {
      return NextResponse.json(
        { error: "Expected a PDF upload in the `pdf` field." },
        { status: 400 },
      );
    }

    if (typeof chapterNumber !== "string" || typeof chapterTitle !== "string") {
      return NextResponse.json(
        { error: "Chapter number and title are required." },
        { status: 400 },
      );
    }

    if (pdf.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: "PDF exceeds the 100 MB upload limit." },
        { status: 413 },
      );
    }

    const openai = getOpenAIClient();
    if (!openai) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not configured on the server." },
        { status: 500 },
      );
    }

    const filename =
      typeof (pdf as { name?: unknown }).name === "string"
        ? ((pdf as { name: string }).name || "book.pdf")
        : "book.pdf";

    const cacheKey =
      typeof bookIdentifier === "string" && bookIdentifier.trim().length > 0
        ? bookIdentifier.trim()
        : request.ip ?? `${filename}:${pdf.size}`;

    if (cacheKey) {
      for (const [key, entry] of storeCache.entries()) {
        if (Date.now() - entry.uploadedAt > MAX_FILE_RETENTION_MS) {
          storeCache.delete(key);
        }
      }
    }

    const existing = cacheKey ? storeCache.get(cacheKey) : null;

    let vectorStoreId: string | null = null;

    if (existing && Date.now() - existing.uploadedAt < MAX_FILE_RETENTION_MS) {
      vectorStoreId = existing.vectorStoreId;
    }

    if (!vectorStoreId) {
      const uploadable = await toFile(
        Readable.fromWeb(pdf.stream() as unknown as ReadableStream<Uint8Array>),
        filename,
        {
          type:
            typeof (pdf as { type?: unknown }).type === "string"
              ? (pdf as { type: string }).type
              : "application/pdf",
        },
      );

      const vectorStore = await openai.vectorStores.create({
        name: `book-${filename}`.slice(0, 63),
      });

      await openai.vectorStores.files.uploadAndPoll(vectorStore.id, uploadable);

      vectorStoreId = vectorStore.id;

      if (cacheKey) {
        storeCache.set(cacheKey, {
          uploadedAt: Date.now(),
          vectorStoreId,
        });
      }
    }

    const systemMessage = `You are an expert curriculum designer. Focus strictly on Chapter ${chapterNumber} titled "${chapterTitle}" within the provided book PDF. Extract between six and ten concise topic areas that best summarize the requested chapter. Each topic must include a short, reader-friendly description. Ignore other chapters even if present.`;

    const response = await openai.responses.create({
      model: MODEL,
      instructions: systemMessage,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Using the indexed book, list 6-10 well-defined topics for Chapter ${chapterNumber} titled "${chapterTitle}". Provide a short learner-friendly description for each topic and omit other chapters.`,
            },
          ],
        },
      ],
      tool_choice: "auto",
      tools: [
        {
          type: "file_search",
          vector_store_ids: [vectorStoreId],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "chapter_topics",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["topics"],
            properties: {
              topics: {
                type: "array",
                minItems: 6,
                maxItems: 10,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["topic", "description"],
                  properties: {
                    topic: { type: "string", minLength: 3 },
                    description: { type: "string", minLength: 10 },
                  },
                },
              },
            },
          },
          strict: true,
        },
      },
    });

    const output = response.output_text?.trim();

    if (!output) {
      throw new Error("OpenAI returned an empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error("Failed to parse model output as JSON.");
    }

    const topics = Array.isArray((parsed as { topics?: unknown }).topics)
      ? ((parsed as { topics: unknown[] }).topics as { topic: string; description: string }[])
      : null;

    if (!topics || topics.length === 0) {
      throw new Error("Model response did not include any topics.");
    }

    return NextResponse.json({ topics, vectorStoreId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to process the chapter topics request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
