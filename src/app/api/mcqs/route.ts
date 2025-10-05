import { NextRequest, NextResponse } from "next/server";
import {
  validateTopics,
  type McqValidatorSummary,
  type TopicValidationPayload,
  type ReplacementMcq,
} from "@/lib/anthropic";
import { getOpenAIClient } from "@/lib/openai";
import {
  type JobPayload,
  type JobRecord,
  type TopicSummary,
  type StoredTopicMcqs,
  type StoredMcqItem,
  getJobStore,
} from "./jobStore";
import { getDbPool } from "@/lib/db";

const MODEL = "gpt-4.1";
const MAX_VALIDATION_ATTEMPTS = 2;

const MCQ_RUBRIC = `You are a K–12 curriculum expert and assessment designer.

Goal: Generate high-quality MCQs strictly from the provided book PDF.

Quantity per topic
- Produce 10–15 MCQs (decide by topic size/complexity).
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

const jobStore = getJobStore();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFilenamePart(raw: string, fallback: string): string {
  const sanitized = raw
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_\-]/g, "");
  return sanitized.length > 0 ? sanitized : fallback;
}

function getErrorStatus(error: unknown): number | null {
  if (!error) {
    return null;
  }

  const candidate = error as { status?: unknown; response?: { status?: unknown } };

  if (typeof candidate.status === "number") {
    return candidate.status;
  }

  if (candidate.response && typeof candidate.response.status === "number") {
    return candidate.response.status;
  }

  return null;
}

interface RetryOptions {
  label?: string;
  log?: (...args: unknown[]) => void;
  maxAttempts?: number;
  initialDelayMs?: number;
}

async function retryWithBackoff<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { label, log } = options;
  const maxAttempts = options.maxAttempts ?? 5;
  let delay = options.initialDelayMs ?? 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const status = getErrorStatus(error);

      if (status === 429 && attempt < maxAttempts) {
        if (log) {
          log(
            `${label ?? "Retryable task"} hit 429. Waiting ${Math.round(delay / 1000)}s before retry ${
              attempt + 1
            }/${maxAttempts}.`,
          );
        }
        await sleep(delay);
        delay *= 2;
        continue;
      }

      throw error;
    }
  }

  throw new Error(`${label ?? "Retryable task"} exhausted all retry attempts.`);
}

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
        minItems: 10,
        maxItems: 15,
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

function toCsv(table: Array<{ topic: string; item: StoredMcqItem }>): string {
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
  mcqs: StoredMcqItem[],
  correctCounts: number[],
): StoredMcqItem[] {
  return mcqs.map((mcq) => {
    const options = Array.isArray(mcq.options) ? [...mcq.options] : [];
    while (options.length < 4) {
      options.push("");
    }

    const originalIndex =
      typeof mcq.correct_index === "number" &&
      mcq.correct_index >= 0 &&
      mcq.correct_index < options.length
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

function cloneMcqItem(item: StoredMcqItem): StoredMcqItem {
  return {
    ...item,
    options: [...item.options],
    source_spans: item.source_spans?.map((span) => ({ ...span })),
  };
}

async function validateAndFinalizeJob(options: {
  jobId: string;
  record: JobRecord;
  generatedTopics: StoredTopicMcqs[];
  classLevel: number;
  subject: { id: number; name: string };
  syllabus: { name: string };
  chapterNumber: number;
  chapterTitle: string;
  log: (...args: unknown[]) => void;
}): Promise<void> {
  const {
    jobId,
    record,
    generatedTopics,
    classLevel,
    subject,
    syllabus,
    chapterNumber,
    chapterTitle,
    log,
  } = options;

  const currentTopics = generatedTopics.map((topic) => ({
    topic: topic.topic,
    items: topic.items.map((item) => cloneMcqItem(item)),
  }));

  const failedTopicSummaries: McqValidatorSummary["topicSummaries"] = [];

  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt += 1) {
    const payload: TopicValidationPayload[] = currentTopics.map((currentTopic) => ({
      topic: currentTopic.topic,
      questions: currentTopic.items.map((item, index) => ({
        index,
        stem: item.stem,
        options: item.options,
        correctLetter: LETTERS[item.correct_index] ?? "A",
        explanation: item.explanation,
        sourceSnippet: item.source_spans?.[0]?.text_snippet ?? null,
        bloom: item.bloom,
        difficulty: item.difficulty,
        type: item.type,
      })),
    }));

    log(`Validation attempt ${attempt} started.`);
    const { summary: validationSummary, usageTotals: anthUsage } = await retryWithBackoff(
      () => validateTopics(payload),
      {
        label: `Anthropic validation attempt ${attempt}`,
        log,
        initialDelayMs: 5000,
        maxAttempts: 6,
      },
    );

    record.anthropicUsage.inputTokens += anthUsage.inputTokens;
    record.anthropicUsage.outputTokens += anthUsage.outputTokens;
    record.anthropicUsage.totalTokens += anthUsage.totalTokens;

    log(
      `Validation attempt ${attempt} token usage — input: ${anthUsage.inputTokens}, output: ${anthUsage.outputTokens}, total: ${anthUsage.totalTokens}.`,
    );

    const rejectedTopics = validationSummary.topicSummaries.filter((topicSummary) =>
      topicSummary.verdicts.some((verdict) => verdict.verdict === "reject"),
    );

    if (rejectedTopics.length === 0) {
      log(`Validation attempt ${attempt} succeeded.`);
      record.summary = validationSummary;
      failedTopicSummaries.length = 0;
      break;
    }

    let replacedAny = false;

    validationSummary.topicSummaries.forEach((topicSummary, topicIndex) => {
      topicSummary.verdicts.forEach((verdict) => {
        if (verdict.verdict === "reject") {
          if (!verdict.replacementMcq) {
            failedTopicSummaries.push(topicSummary);
            return;
          }

          const bucket = currentTopics[topicIndex];
          const fallback = bucket.items[verdict.index];
          bucket.items[verdict.index] = normalizeReplacementMcq(
            verdict.replacementMcq,
            fallback,
          );
          replacedAny = true;
          log(`Applied replacement for topic "${topicSummary.topic}" question ${verdict.index}.`);
        }
      });
    });

    if (!replacedAny) {
      log("Validation failed without any provided replacements for at least one topic.");
      failedTopicSummaries.push(...rejectedTopics);
      break;
    }
  }

  const successfulTopics = currentTopics.filter((topic) =>
    !failedTopicSummaries.some((failed) => failed.topic === topic.topic),
  );

  if (successfulTopics.length === 0) {
    record.status = "failed";
    record.summary = {
      overallStatus: "rejected",
      topicSummaries: failedTopicSummaries,
    };
    record.error = "All topics failed validation.";
    record.allowValidationRetry = false;
    log(record.error);
    return;
  }

  if (failedTopicSummaries.length > 0) {
    log(`Validation completed with ${failedTopicSummaries.length} topic(s) requiring manual review.`);
  }

  const correctCounts = [0, 0, 0, 0];
  const rows: Array<{ topic: string; item: StoredMcqItem }> = [];

  successfulTopics.forEach((topicBucket) => {
    const balanced = rebalanceCorrectOptions(topicBucket.items, correctCounts);
    topicBucket.items = balanced;
    balanced.forEach((item) => {
      rows.push({ topic: topicBucket.topic, item });
    });
  });

  try {
    await persistChapterToDatabase({
      classLevel,
      subjectId: subject.id,
      chapterNumber,
      chapterTitle,
      syllabusName: syllabus.name,
      topics: successfulTopics.map((topic) => ({
        name: topic.topic,
        items: topic.items,
      })),
      log,
    });
  } catch (persistError) {
    console.error(`[job ${jobId}] Database persistence failed`, persistError);
    record.status = "failed";
    record.error = "Failed to persist MCQs to the database.";
    record.allowValidationRetry = false;
    record.allowPersistenceRetry = Array.isArray(record.generatedTopics)
      && record.generatedTopics.length > 0;
    record.updatedAt = Date.now();
    log(
      "Database persistence failed:",
      persistError instanceof Error ? persistError.message : persistError,
    );
    return;
  }

  const csv = `\ufeff${toCsv(rows)}`;

  record.resultCsv = csv;
  record.summary = {
    overallStatus: failedTopicSummaries.length === 0 ? "approved" : "mixed",
    topicSummaries: failedTopicSummaries.length === 0 ? [] : failedTopicSummaries,
  };
  const classPart = makeFilenamePart(`Class ${classLevel}`, "Class");
  const subjectPart = makeFilenamePart(subject.name ?? "Subject", "Subject");
  const chapterPart = makeFilenamePart(chapterTitle, "Chapter");
  const syllabusPart = makeFilenamePart(syllabus.name ?? "Syllabus", "Syllabus");
  record.outputFilename = `${classPart}_${subjectPart}_${chapterPart}_${syllabusPart}.csv`;
  record.status = failedTopicSummaries.length === 0 ? "succeeded" : "succeeded";
  record.error = failedTopicSummaries.length === 0
    ? undefined
    : "One or more topics require manual review.";
  record.allowValidationRetry = false;
  record.allowPersistenceRetry = false;
  record.updatedAt = Date.now();
  log(
    `Total OpenAI tokens used: input ${record.openAiUsage.inputTokens}, output ${record.openAiUsage.outputTokens}, total ${record.openAiUsage.totalTokens}.`,
  );
  log(
    `Total Anthropic tokens used: input ${record.anthropicUsage.inputTokens}, output ${record.anthropicUsage.outputTokens}, total ${record.anthropicUsage.totalTokens}.`,
  );
  log(
    failedTopicSummaries.length === 0
      ? "Job completed successfully."
      : "Job completed partially; some topics need manual review.",
  );
}

async function persistChapterToDatabase(options: {
  classLevel: number;
  subjectId: number;
  chapterNumber: number;
  chapterTitle: string;
  syllabusName: string;
  topics: Array<{ name: string; items: StoredMcqItem[] }>;
  log: (...args: unknown[]) => void;
}) {
  const { classLevel, subjectId, chapterNumber, chapterTitle, syllabusName, topics, log } = options;
  const pool = getDbPool();
  const client = await pool.connect();
  const classLabel = `Class ${classLevel}`;
  const normalizedChapterTitle = chapterTitle.trim();
  const chapterLogLabel = `Chapter ${chapterNumber}: ${normalizedChapterTitle}`.trim();
  const normalizedSyllabus = syllabusName.trim();

  try {
    await client.query("BEGIN");

    let chapterId: number;
    let existingChapter = await client.query<{ id: number; syllabus: string | null }>(
      `SELECT id, syllabus FROM chapters WHERE subject_id = $1 AND class = $2 AND chapter_name = $3`,
      [subjectId, classLabel, normalizedChapterTitle],
    );

    if (!existingChapter.rowCount) {
      const legacyChapter = await client.query<{ id: number; syllabus: string | null }>(
        `SELECT id, syllabus FROM chapters WHERE subject_id = $1 AND class = $2 AND chapter_name = $3`,
        [subjectId, classLabel, chapterLogLabel],
      );

      if (legacyChapter.rowCount && legacyChapter.rows[0]) {
        const legacyId = legacyChapter.rows[0].id;
        await client.query(`UPDATE chapters SET chapter_name = $1 WHERE id = $2`, [
          normalizedChapterTitle,
          legacyId,
        ]);
        existingChapter = legacyChapter;
        log(
          `Migrated chapter #${legacyId} for ${classLabel} to use plain title "${normalizedChapterTitle}".`,
        );
      }
    }

    if (existingChapter.rowCount && existingChapter.rows[0]) {
      chapterId = existingChapter.rows[0].id;
      log(`Using existing chapter #${chapterId} for ${classLabel} – ${chapterLogLabel}.`);
      if ((existingChapter.rows[0].syllabus ?? "").trim() !== normalizedSyllabus) {
        await client.query(`UPDATE chapters SET syllabus = $1 WHERE id = $2`, [
          normalizedSyllabus,
          chapterId,
        ]);
        log(`Updated syllabus for chapter #${chapterId} to ${normalizedSyllabus}.`);
      }
    } else {
      const insertedChapter = await client.query<{ id: number }>(
        `INSERT INTO chapters (subject_id, class, chapter_name, syllabus)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [subjectId, classLabel, normalizedChapterTitle, normalizedSyllabus],
      );
      chapterId = insertedChapter.rows[0].id;
      log(`Inserted chapter #${chapterId} for ${classLabel} – ${chapterLogLabel}.`);
    }

    for (const topic of topics) {
      const topicResult = await client.query<{ id: number }>(
        `INSERT INTO topics (subject_id, name, class, chapter_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (subject_id, name, class)
         DO UPDATE SET chapter_id = EXCLUDED.chapter_id
         RETURNING id`,
        [subjectId, topic.name, classLabel, chapterId],
      );

      const topicId = topicResult.rows[0].id;
      log(`Upserted topic "${topic.name}" with id ${topicId}.`);

      await client.query(`DELETE FROM questions WHERE topic_id = $1 AND class = $2`, [
        topicId,
        classLabel,
      ]);

      for (const item of topic.items) {
        const optionsPadded = [...item.options];
        while (optionsPadded.length < 4) {
          optionsPadded.push("");
        }

        const correctLetter = LETTERS[item.correct_index] ?? LETTERS[0];

        await client.query(
          `INSERT INTO questions (
             topic_id,
             class,
             question_text,
             option_a,
             option_b,
             option_c,
             option_d,
             correct_answer,
             explanation,
             image_url
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            topicId,
            classLabel,
            item.stem,
            optionsPadded[0],
            optionsPadded[1],
            optionsPadded[2],
            optionsPadded[3],
            correctLetter,
            item.explanation ?? "",
            null,
          ],
        );
      }
    }

    await client.query("COMMIT");
    log("Chapter, topics, and questions stored in the database.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function normalizeReplacementMcq(
  replacement: ReplacementMcq,
  fallback: StoredMcqItem,
): StoredMcqItem {
  const options = Array.isArray(replacement.options)
    ? [...replacement.options]
    : [...fallback.options];

  while (options.length < 4) {
    options.push("");
  }

  const correctIndex =
    typeof replacement.correct_index === "number" &&
    replacement.correct_index >= 0 &&
    replacement.correct_index <= 3
      ? replacement.correct_index
      : fallback.correct_index;

  const normalizedSpans = (() => {
    if (replacement.source_spans && replacement.source_spans.length > 0) {
      return replacement.source_spans.map((span) => ({
        page: typeof span.page === "number" ? span.page : null,
        text_snippet: span.text_snippet ?? "",
      }));
    }

    if (replacement.sources && replacement.sources.length > 0) {
      return replacement.sources.map((span) => ({
        page:
          typeof span.page === "number"
            ? span.page
            : span.page === null || span.page === undefined
              ? null
              : Number.parseInt(String(span.page), 10) || null,
        text_snippet: span.text_snippet ?? "",
      }));
    }

    return fallback.source_spans;
  })();

  return {
    ...fallback,
    bloom: replacement.bloom ?? fallback.bloom,
    difficulty: replacement.difficulty ?? fallback.difficulty,
    type: replacement.type ?? fallback.type,
    stem: replacement.stem ?? fallback.stem,
    options,
    correct_index: correctIndex,
    explanation: replacement.explanation ?? fallback.explanation,
    source_spans: normalizedSpans,
  };
}

interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

async function generateMcqsForTopic(options: {
  openai: OpenAIClient;
  topic: TopicSummary;
  chapterNumber: number;
  chapterTitle: string;
  vectorStoreId: string;
  topicIndex: number;
  totalTopics: number;
}): Promise<{ mcqs: StoredMcqItem[]; usage?: OpenAiUsage }> {
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
  } catch {
    throw new Error(`Failed to parse MCQ JSON response for topic "${topic.topic}".`);
  }

  const mcqs = Array.isArray((parsed as { mcqs?: unknown }).mcqs)
    ? ((parsed as { mcqs: StoredMcqItem[] }).mcqs as StoredMcqItem[])
    : null;

  if (!mcqs || mcqs.length === 0) {
    throw new Error(`Model did not return any MCQs for topic "${topic.topic}".`);
  }

  if (mcqs.length < 10 || mcqs.length > 15) {
    throw new Error(
      `Model returned ${mcqs.length} MCQs for topic "${topic.topic}". Provide between 10 and 15 items based on topic complexity.`,
    );
  }

  const usage = response.usage as OpenAiUsage | undefined;

  return { mcqs, usage };
}

function logJob(record: JobRecord, jobId: string, ...args: unknown[]) {
  const message = `[job ${jobId}] ${args.join(" ")}`;
  console.log(message);
  record.logs.push(message);
  record.updatedAt = Date.now();
}

async function processJob(jobId: string, record: JobRecord): Promise<void> {
  record.status = "processing";
  record.updatedAt = Date.now();

  const log = (...args: unknown[]) => logJob(record, jobId, ...args);
  log("Processing started.");

  try {
    const {
      chapterNumber,
      chapterTitle,
      topics,
      vectorStoreId,
      classLevel,
      subject,
      syllabus,
    } = record.payload;

    if (!subject || typeof subject.id !== "number") {
      throw new Error("Subject information missing in job payload.");
    }

    if (!syllabus || typeof syllabus.name !== "string") {
      throw new Error("Syllabus information missing in job payload.");
    }

    log(
      `Starting job for Class ${classLevel}, Subject ${subject.name}, Syllabus ${syllabus.name}.`,
    );

    const openai = getOpenAIClient();
    if (!openai) {
      throw new Error("OPENAI_API_KEY is not configured on the server.");
    }

    record.generatedTopics = undefined;
    record.allowValidationRetry = false;
    record.allowPersistenceRetry = false;

    const generatedTopics: StoredTopicMcqs[] = [];

    for (const [index, topic] of topics.entries()) {
      const { mcqs, usage } = await retryWithBackoff(
        async () =>
          generateMcqsForTopic({
            openai,
            topic,
            chapterNumber,
            chapterTitle,
            vectorStoreId,
            topicIndex: index,
            totalTopics: topics.length,
          }),
        {
          label: `OpenAI generation for topic "${topic.topic}"`,
          log,
          initialDelayMs: 5000,
          maxAttempts: 6,
        },
      );

      log(
        `Generated ${mcqs.length} MCQs for topic "${topic.topic}" (${index + 1}/${topics.length}).` +
          (usage
            ? ` Tokens — input: ${usage.input_tokens ?? 0}, output: ${usage.output_tokens ?? 0}, total: ${usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)}`
            : ""),
      );

      if (usage) {
        record.openAiUsage.inputTokens += usage.input_tokens ?? 0;
        record.openAiUsage.outputTokens += usage.output_tokens ?? 0;
        record.openAiUsage.totalTokens += usage.total_tokens
          ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      }

      generatedTopics.push({ topic: topic.topic, items: mcqs.map((item) => cloneMcqItem(item)) });
    }
    record.generatedTopics = generatedTopics.map((topic) => ({
      topic: topic.topic,
      items: topic.items.map((item) => cloneMcqItem(item)),
    }));
    record.allowValidationRetry = false;

    await validateAndFinalizeJob({
      jobId,
      record,
      generatedTopics: record.generatedTopics.map((topic) => ({
        topic: topic.topic,
        items: topic.items.map((item) => cloneMcqItem(item)),
      })),
      classLevel,
      subject,
      syllabus,
      chapterNumber,
      chapterTitle,
      log,
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected MCQ generation failure.";
    console.error(`[job ${jobId}]`, error);
    record.status = "failed";
    record.error = message;
    const status = getErrorStatus(error);
    if (status === 529 && Array.isArray(record.generatedTopics) && record.generatedTopics.length > 0) {
      record.allowValidationRetry = true;
      record.allowPersistenceRetry = true;
      log("Anthropic returned overloaded; validation can be retried without regenerating MCQs.");
    } else {
      record.allowValidationRetry = false;
      record.allowPersistenceRetry = Array.isArray(record.generatedTopics) && record.generatedTopics.length > 0;
    }
    record.updatedAt = Date.now();
    log("Job failed:", message);
    log(
      `Total OpenAI tokens used before failure: input ${record.openAiUsage.inputTokens}, output ${record.openAiUsage.outputTokens}, total ${record.openAiUsage.totalTokens}.`,
    );
    log(
      `Total Anthropic tokens used before failure: input ${record.anthropicUsage.inputTokens}, output ${record.anthropicUsage.outputTokens}, total ${record.anthropicUsage.totalTokens}.`,
    );
  }
}

async function retryValidation(jobId: string, record: JobRecord): Promise<void> {
  record.status = "processing";
  record.updatedAt = Date.now();

  const log = (...args: unknown[]) => logJob(record, jobId, ...args);
  log("Validation retry started.");

  try {
    const {
      chapterNumber,
      chapterTitle,
      classLevel,
      subject,
      syllabus,
    } = record.payload;

    if (!subject || typeof subject.id !== "number") {
      throw new Error("Subject information missing in job payload.");
    }

    if (!syllabus || typeof syllabus.name !== "string") {
      throw new Error("Syllabus information missing in job payload.");
    }

    if (!Array.isArray(record.generatedTopics) || record.generatedTopics.length === 0) {
      throw new Error("No generated MCQs available for validation retry.");
    }

    record.allowValidationRetry = false;
    record.allowPersistenceRetry = false;

    await validateAndFinalizeJob({
      jobId,
      record,
      generatedTopics: record.generatedTopics.map((topic) => ({
        topic: topic.topic,
        items: topic.items.map((item) => cloneMcqItem(item)),
      })),
      classLevel,
      subject,
      syllabus,
      chapterNumber,
      chapterTitle,
      log,
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : "Validation retry failed.";
    console.error(`[job ${jobId}] validation retry`, error);
    record.status = "failed";
    record.error = message;
    const status = getErrorStatus(error);
    if (status === 529 && Array.isArray(record.generatedTopics) && record.generatedTopics.length > 0) {
      record.allowValidationRetry = true;
      record.allowPersistenceRetry = false;
      log("Anthropic returned overloaded during retry; validation can be attempted again.");
    } else {
      record.allowValidationRetry = false;
      record.allowPersistenceRetry = false;
    }
    record.updatedAt = Date.now();
    log("Validation retry failed:", message);
  }
}

async function retryPersistence(jobId: string, record: JobRecord): Promise<void> {
  record.status = "processing";
  record.updatedAt = Date.now();

  const log = (...args: unknown[]) => logJob(record, jobId, ...args);
  log("Persistence retry started.");

  try {
    const {
      chapterNumber,
      chapterTitle,
      classLevel,
      subject,
      syllabus,
    } = record.payload;

    if (!subject || typeof subject.id !== "number") {
      throw new Error("Subject information missing in job payload.");
    }

    if (!syllabus || typeof syllabus.name !== "string") {
      throw new Error("Syllabus information missing in job payload.");
    }

    if (!Array.isArray(record.generatedTopics) || record.generatedTopics.length === 0) {
      throw new Error("No generated MCQs available for persistence retry.");
    }

    record.allowValidationRetry = false;
    record.allowPersistenceRetry = false;

    await validateAndFinalizeJob({
      jobId,
      record,
      generatedTopics: record.generatedTopics.map((topic) => ({
        topic: topic.topic,
        items: topic.items.map((item) => cloneMcqItem(item)),
      })),
      classLevel,
      subject,
      syllabus,
      chapterNumber,
      chapterTitle,
      log,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Persistence retry failed.";
    console.error(`[job ${jobId}] persistence retry`, error);
    record.status = "failed";
    record.error = message;
    const status = getErrorStatus(error);
    if (status === 529 && Array.isArray(record.generatedTopics) && record.generatedTopics.length > 0) {
      record.allowValidationRetry = true;
      record.allowPersistenceRetry = true;
      log("Anthropic returned overloaded during persistence retry; validation can be attempted again.");
    } else {
      const canRetry = Array.isArray(record.generatedTopics) && record.generatedTopics.length > 0;
      record.allowValidationRetry = false;
      record.allowPersistenceRetry = canRetry;
    }
    record.updatedAt = Date.now();
    log("Persistence retry failed:", message);
  }
}

function createJob(payload: JobPayload): JobRecord {
  const jobId = crypto.randomUUID();
  const now = Date.now();

  const record: JobRecord = {
    id: jobId,
    status: "pending",
    payload,
    createdAt: now,
    updatedAt: now,
    logs: [],
    summary: null,
    openAiUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    anthropicUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    generatedTopics: undefined,
    allowValidationRetry: false,
    allowPersistenceRetry: false,
  };

  jobStore.set(jobId, record);
  return record;
}

globalThis.__mcqRetryValidation = retryValidation;
globalThis.__mcqRetryPersistence = retryPersistence;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      chapterNumber,
      chapterTitle,
      topics,
      vectorStoreId,
      bookFingerprint = null,
      classLevel,
      subject,
      syllabus,
    }: {
      chapterNumber: number;
      chapterTitle: string;
      topics: TopicSummary[];
      vectorStoreId: string;
      bookFingerprint?: string | null;
      classLevel: number;
      subject: { id?: number | null; name?: string };
      syllabus: { id?: number | null; name?: string };
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

    if (typeof classLevel !== "number" || Number.isNaN(classLevel)) {
      return NextResponse.json({ error: "Class level is required." }, { status: 400 });
    }

    if (
      !subject ||
      typeof subject.name !== "string" ||
      subject.name.trim().length === 0 ||
      typeof subject.id !== "number"
    ) {
      return NextResponse.json({ error: "Subject is required." }, { status: 400 });
    }

    if (
      !syllabus ||
      typeof syllabus.name !== "string" ||
      syllabus.name.trim().length === 0 ||
      typeof syllabus.id !== "number"
    ) {
      return NextResponse.json({ error: "Syllabus is required." }, { status: 400 });
    }

    const payload: JobPayload = {
      chapterNumber,
      chapterTitle,
      topics,
      vectorStoreId,
      bookFingerprint,
      classLevel,
      subject: {
        id: subject.id,
        name: subject.name.trim(),
      },
      syllabus: {
        id: syllabus.id,
        name: syllabus.name.trim(),
      },
    };

    const record = createJob(payload);
    const jobId = record.id;

    record.status = "pending";
    record.updatedAt = Date.now();

    void processJob(jobId, record);

    return NextResponse.json({ jobId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to create MCQs at this time.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
