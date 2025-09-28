import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient } from "@/lib/openai";

const MODEL = "gpt-4.1";

const MCQ_RUBRIC = `You are a K–12 curriculum expert and assessment designer.

Goal: Generate high-quality MCQs strictly from the provided book PDF.

Quantity per topic
- Produce 10–20 MCQs (decide by topic size/complexity).
- Keep questions varied and non-redundant.

Diverse types (mix across the set)
- Direct recall
- Application / word problem
- Assertion–Reason
- Fill-in-the-blank (convert to 4 options; only one correct)
- (Optional) One diagram/figure-based if the text clearly supports it

Bloom’s distribution (across the whole set)
- 20% Remember
- 25% Understand
- 25% Apply
- 20% Analyze
- 10% Evaluate/Create

Answer balancing
- Shuffle correct answers among A, B, C, D.
- No single option is correct > 40% of the time across the set.
- The "correct_index" must match the shuffled option (0=A, 1=B, 2=C, 3=D).
- This distribution rule is mandatory; adjust choices internally before responding so it is satisfied.

Explanations
- Friendly teacher tone, step-by-step, suitable for self-study.
- Do NOT prefix with “Correct option is…”.
- Provide clear, slightly longer teaching-style notes (1–3 sentences).

Must Rules
- Use only facts present or logically entailed by the topic content in the book.
- Keep stems concise; avoid clues like “All/None of the above”.
- Each MCQ must have exactly one correct choice.
- If the topic content is too thin, reduce count but keep Bloom balance as close as possible.

Formatting & schema (JSON only)
{
  "mcqs": [
    {
      "bloom": "Remember|Understand|Apply|Analyze|Evaluate|Create",
      "difficulty": "Easy|Medium|Hard",
      "stem": "string",
      "options": ["A text","B text","C text","D text"],
      "correct_index": 0,
      "explanation": "string",
      "type": "recall|application|assertion-reason|fill-blank|diagram",
      "source_spans": [{"page": 0, "text_snippet": "string"}]
    }
  ]
}`;

interface TopicSummary {
  topic: string;
  description: string;
}

interface McqItem {
  bloom: string;
  difficulty: string;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  type: string;
}

const CSV_HEADERS = [
  "Topic",
  "Question_text",
  "Option A",
  "Option B",
  "Option C",
  "Option D",
  "Correct_Answer",
  "Explanation",
] as const;

const LETTERS = ["A", "B", "C", "D"];

function buildInstructionPrompt(
  topic: TopicSummary,
  chapterNumber: number,
  chapterTitle: string,
  index: number,
  totalTopics: number,
): string {
  return `${MCQ_RUBRIC}\n\nChapter focus: Chapter ${chapterNumber} – "${chapterTitle}".\nTopic focus (${index + 1} of ${totalTopics}): ${topic.topic}.\nTopic summary: ${topic.description}`;
}

function buildUserPrompt(topic: TopicSummary): string {
  return `Create MCQs strictly for the topic "${topic.topic}" using only the retrieved book context. Ensure the question set reflects the topic description: ${topic.description}.`;
}

function buildJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["mcqs"],
    properties: {
      mcqs: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "bloom",
            "difficulty",
            "stem",
            "options",
            "correct_index",
            "explanation",
            "type",
            "source_spans",
          ],
          properties: {
            bloom: {
              type: "string",
              enum: ["Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"],
            },
            difficulty: {
              type: "string",
              enum: ["Easy", "Medium", "Hard"],
            },
            stem: { type: "string", minLength: 3 },
            options: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: { type: "string", minLength: 1 },
            },
            correct_index: {
              type: "integer",
              minimum: 0,
              maximum: 3,
            },
            explanation: { type: "string", minLength: 10 },
            type: {
              type: "string",
              enum: ["recall", "application", "assertion-reason", "fill-blank", "diagram"],
            },
            source_spans: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["page", "text_snippet"],
                properties: {
                  page: { type: "integer", minimum: 0 },
                  text_snippet: { type: "string", minLength: 5 },
                },
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
  } as const;
}

function toCsv(table: Array<{ topic: string; item: McqItem }>): string {
  const rows: string[][] = [CSV_HEADERS.slice()];

  for (const entry of table) {
    const options = entry.item.options ?? [];
    const paddedOptions = [0, 1, 2, 3].map((index) => options[index] ?? "");
    const correctIndex =
      typeof entry.item.correct_index === "number" &&
      entry.item.correct_index >= 0 &&
      entry.item.correct_index < LETTERS.length
        ? entry.item.correct_index
        : 0;
    const correctLetter = LETTERS[correctIndex];

    rows.push([
      entry.topic,
      entry.item.stem,
      ...paddedOptions,
      correctLetter,
      entry.item.explanation,
    ]);
  }

  return rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

function shuffle<T>(values: T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function selectBalancedIndex(correctCounts: number[]): number {
  const minCount = Math.min(...correctCounts);
  const candidates: number[] = [];

  correctCounts.forEach((count, index) => {
    if (count === minCount) {
      candidates.push(index);
    }
  });

  const choice = Math.floor(Math.random() * candidates.length);
  return candidates[choice] ?? 0;
}

function rebalanceCorrectOptions(
  mcqs: McqItem[],
  correctCounts: number[],
): McqItem[] {
  return mcqs.map((mcq) => {
    const options = Array.isArray(mcq.options) ? [...mcq.options] : [];
    while (options.length < 4) {
      options.push("");
    }

    const originalIndex =
      typeof mcq.correct_index === "number" && mcq.correct_index >= 0 && mcq.correct_index < options.length
        ? mcq.correct_index
        : 0;
    const correctOption = options[originalIndex] ?? "";
    const otherOptions = options.filter((_, index) => index !== originalIndex);
    const shuffledOthers = shuffle(otherOptions);

    const desiredIndex = selectBalancedIndex(correctCounts);
    const newOptions: string[] = [];
    let fillerPointer = 0;

    for (let index = 0; index < 4; index += 1) {
      if (index === desiredIndex) {
        newOptions.push(correctOption);
      } else {
        newOptions.push(shuffledOthers[fillerPointer] ?? "");
        fillerPointer += 1;
      }
    }

    correctCounts[desiredIndex] += 1;

    return {
      ...mcq,
      options: newOptions,
      correct_index: desiredIndex,
    };
  });
}

type OpenAIClient = NonNullable<ReturnType<typeof getOpenAIClient>>;

async function generateMcqsForTopic(options: {
  openai: OpenAIClient;
  topic: TopicSummary;
  chapterNumber: number;
  chapterTitle: string;
  vectorStoreId: string;
  topicIndex: number;
  totalTopics: number;
}) {
  const { openai, topic, chapterNumber, chapterTitle, vectorStoreId, topicIndex, totalTopics } = options;

  const instructions = buildInstructionPrompt(topic, chapterNumber, chapterTitle, topicIndex, totalTopics);
  const userPrompt = buildUserPrompt(topic);

  const response = await openai.responses.create({
    model: MODEL,
    instructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: userPrompt,
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
        name: `mcq_batch_topic_${topicIndex + 1}`,
        schema: buildJsonSchema(),
        strict: true,
      },
    },
  });

  const output = response.output_text?.trim();

  if (!output) {
    throw new Error(`OpenAI returned an empty MCQ payload for topic "${topic.topic}".`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Failed to parse MCQ JSON response for topic "${topic.topic}".`);
  }

  const mcqs = Array.isArray((parsed as { mcqs?: unknown }).mcqs)
    ? ((parsed as { mcqs: McqItem[] }).mcqs as McqItem[])
    : null;

  if (!mcqs || mcqs.length === 0) {
    throw new Error(`Model did not return any MCQs for topic "${topic.topic}".`);
  }

  return mcqs;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      chapterNumber,
      chapterTitle,
      topics,
      vectorStoreId,
    }: {
      chapterNumber: number;
      chapterTitle: string;
      topics: TopicSummary[];
      vectorStoreId: string;
    } = body ?? {};

    if (!Array.isArray(topics) || topics.length === 0) {
      return NextResponse.json({ error: "Topics are required to generate MCQs." }, { status: 400 });
    }

    if (!vectorStoreId || typeof vectorStoreId !== "string") {
      return NextResponse.json({ error: "Missing vector store id for file search." }, { status: 400 });
    }

    if (typeof chapterNumber !== "number" || Number.isNaN(chapterNumber)) {
      return NextResponse.json({ error: "Chapter number must be a number." }, { status: 400 });
    }

    if (typeof chapterTitle !== "string" || chapterTitle.trim().length === 0) {
      return NextResponse.json({ error: "Chapter title is required." }, { status: 400 });
    }

    const openai = getOpenAIClient();
    if (!openai) {
      return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server." }, { status: 500 });
    }

    const rows: Array<{ topic: string; item: McqItem }> = [];
    const correctCounts = [0, 0, 0, 0];

    for (const [index, topic] of topics.entries()) {
      const mcqsForTopic = await generateMcqsForTopic({
        openai,
        topic,
        chapterNumber,
        chapterTitle,
        vectorStoreId,
        topicIndex: index,
        totalTopics: topics.length,
      });

      const balancedItems = rebalanceCorrectOptions(mcqsForTopic, correctCounts);

      for (const item of balancedItems) {
        rows.push({ topic: topic.topic, item });
      }
    }

    const csv = `\ufeff${toCsv(rows)}`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="chapter-${chapterNumber}-mcqs.csv"`,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to create MCQs at this time.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
