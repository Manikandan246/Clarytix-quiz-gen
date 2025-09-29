import { jsonrepair } from "jsonrepair";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export function getAnthropicApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY;

  if (!key || key.trim().length === 0) {
    return null;
  }

  return key;
}

export interface ReplacementMcq {
  bloom?: string;
  difficulty?: string;
  type?: string;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  source_spans?: Array<{ page: number | null; text_snippet: string }>;
  sources?: Array<{ page?: number | string | null; text_snippet?: string }>;
}

export interface TopicValidationQuestion {
  index: number;
  stem: string;
  options: string[];
  correctLetter: string;
  explanation: string;
  sourceSnippet?: string | null;
  bloom?: string;
  difficulty?: string;
  type?: string;
}

export interface TopicValidationPayload {
  topic: string;
  questions: TopicValidationQuestion[];
}

export interface TopicValidationVerdict {
  index: number;
  verdict: "approve" | "reject";
  reasons: string[];
  explanationAlignment: "strong" | "weak" | "missing";
  correctAnswerConfirmed: boolean;
  confidence: "high" | "medium" | "low";
  replacementMcq?: ReplacementMcq;
}

export interface TopicValidationResponse {
  topic: string;
  verdicts: TopicValidationVerdict[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export interface McqValidatorSummary {
  overallStatus: "approved" | "rejected" | "mixed";
  topicSummaries: TopicValidationResponse[];
}

const CLAUDE_MODEL = "claude-3-haiku-20240307";
const MAX_VALIDATOR_TOKENS = 1024;

function buildTopicValidationPrompt(payload: TopicValidationPayload): string {
  const header = [
    "You are a meticulous educational assessor tasked with validating a set of multiple-choice questions for a single topic.",
    "For each question, determine whether the provided correct answer and explanation are fully justified by the supplied context.",
    "If a question is flawed, rewrite it so it satisfies the rubric before returning your decision.",
    "Respond in JSON only using this format:",
    "{",
    '  "topic": string,',
    '  "verdicts": [',
    '    {',
    '      "index": number,',
    '      "verdict": "approve" | "reject",',
    '      "reasons": string[],',
    '      "explanationAlignment": "strong" | "weak" | "missing",',
    '      "correctAnswerConfirmed": boolean,',
    '      "confidence": "high" | "medium" | "low",',
    '      "replacement_mcq": null | {',
    '        "bloom": string,',
    '        "difficulty": string,',
    '        "type": string,',
    '        "stem": string,',
    '        "options": string[4],',
    '        "correct_index": 0 | 1 | 2 | 3,',
    '        "explanation": string,',
    '        "source_spans": [{ "page": number | null, "text_snippet": string }]',
    "      }",
    "    }",
    "  ]",
    "}",
    "Each verdict must correspond to the question index provided in the input.",
  ];

  const questionBlocks = payload.questions.map((question) => {
    const optionLines = question.options
      .map((option, idx) => `    ${String.fromCharCode(65 + idx)}) ${option}`)
      .join("\n");

    const details: string[] = [
      `  - Index: ${question.index}`,
      `    Stem: ${question.stem}`,
      optionLines,
      `    Provided correct answer: ${question.correctLetter}`,
      `    Explanation: ${question.explanation}`,
    ];

    if (question.bloom) {
      details.push(`    Bloom: ${question.bloom}`);
    }
    if (question.difficulty) {
      details.push(`    Difficulty: ${question.difficulty}`);
    }
    if (question.type) {
      details.push(`    Type: ${question.type}`);
    }
    if (question.sourceSnippet) {
      details.push(`    Source snippet: ${question.sourceSnippet}`);
    }

    return details.join("\n");
  });

  return `${header.join("\n")}\n\nTopic: ${payload.topic}\nQuestions:\n${questionBlocks.join("\n\n")}`;
}

function sanitizeJsonText(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("```")) {
    const withoutOpening = trimmed.replace(/^```[a-zA-Z]*\n?/u, "");
    const closingIndex = withoutOpening.lastIndexOf("```\n");

    if (closingIndex !== -1) {
      return withoutOpening.slice(0, closingIndex).trim();
    }

    return withoutOpening.replace(/```$/u, "").trim();
  }

  return trimmed;
}

function normaliseReplacement(replacement: ReplacementMcq): ReplacementMcq {
  const options = Array.isArray(replacement.options)
    ? [...replacement.options]
    : [];

  while (options.length < 4) {
    options.push("");
  }

  return {
    ...replacement,
    options,
    source_spans:
      replacement.source_spans && replacement.source_spans.length > 0
        ? replacement.source_spans.map((span) => ({
            page:
              typeof span.page === "number"
                ? span.page
                : span.page === null
                  ? null
                  : Number.parseInt(String(span.page), 10) || null,
            text_snippet: span.text_snippet ?? "",
          }))
        : replacement.sources && replacement.sources.length > 0
          ? replacement.sources.map((span) => ({
              page:
                typeof span.page === "number"
                  ? span.page
                  : span.page === null || span.page === undefined
                    ? null
                    : Number.parseInt(String(span.page), 10) || null,
              text_snippet: span.text_snippet ?? "",
            }))
          : undefined,
  };
}

async function callAnthropicValidatorForTopic(
  payload: TopicValidationPayload,
): Promise<TopicValidationResponse> {
  const apiKey = getAnthropicApiKey();

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured on the server.");
  }

  const prompt = buildTopicValidationPrompt(payload);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_VALIDATOR_TOKENS,
      system:
        "You are a rigorous assessment validator. Respond only with JSON following the provided schema.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    const error = new Error(
      `Anthropic validation failed: ${response.status} ${response.statusText} – ${message}`,
    );
    (error as { status?: number }).status = response.status;
    throw error;
  }

  const json = (await response.json()) as { content?: Array<{ text?: string }>; error?: unknown };
  const textOutput = sanitizeJsonText(json.content?.[0]?.text ?? "");

  if (!textOutput) {
    throw new Error("Anthropic validator returned an empty body.");
  }

  let parsed: TopicValidationResponse;

  try {
    parsed = JSON.parse(textOutput) as TopicValidationResponse;
  } catch (error) {
    console.error("[anthropic] Failed to parse topic validation JSON", error, "output:", textOutput);

    try {
      const repaired = jsonrepair(textOutput);
      parsed = JSON.parse(repaired) as TopicValidationResponse;
      console.warn("[anthropic] JSON repaired successfully for topic", payload.topic);
    } catch (repairError) {
      console.error(
        "[anthropic] Unable to repair topic validation JSON",
        repairError,
        "original output:",
        textOutput,
      );
      throw repairError;
    }
  }

  const verdicts = (parsed.verdicts ?? []).map((verdict) => {
    const replacement = (verdict as { replacement_mcq?: ReplacementMcq }).replacement_mcq;

    return {
      index: verdict.index ?? 0,
      verdict: verdict.verdict ?? (replacement ? "reject" : "approve"),
      reasons: Array.isArray(verdict.reasons) ? verdict.reasons : [],
      explanationAlignment: verdict.explanationAlignment ?? (replacement ? "weak" : "strong"),
      correctAnswerConfirmed:
        typeof verdict.correctAnswerConfirmed === "boolean"
          ? verdict.correctAnswerConfirmed
          : !replacement,
      confidence: verdict.confidence ?? (replacement ? "medium" : "high"),
      ...(replacement ? { replacementMcq: normaliseReplacement(replacement) } : {}),
    } as TopicValidationVerdict;
  });

  const usage = (json as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }).usage;

  return {
    topic: parsed.topic ?? payload.topic,
    verdicts,
    usage,
  };
}

export interface TopicValidationTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ValidationRunResult {
  summary: McqValidatorSummary;
  usageTotals: TopicValidationTotals;
}

export async function validateTopics(
  topics: TopicValidationPayload[],
): Promise<ValidationRunResult> {
  if (topics.length === 0) {
    return {
      summary: {
        overallStatus: "approved",
        topicSummaries: [],
      },
      usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  const summaries: TopicValidationResponse[] = [];
  const usageTotals: TopicValidationTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (const topic of topics) {
    console.log("[validator] Validating topic", topic.topic, "questionCount", topic.questions.length);
    const result = await callAnthropicValidatorForTopic(topic);
    summaries.push(result);

    if (result.usage) {
      usageTotals.inputTokens += result.usage.input_tokens ?? 0;
      usageTotals.outputTokens += result.usage.output_tokens ?? 0;
      usageTotals.totalTokens += result.usage.total_tokens
        ?? (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0);
    }
  }

  const allVerdicts = summaries.flatMap((summary) => summary.verdicts);
  const rejected = allVerdicts.some((verdict) => verdict.verdict === "reject");
  const approved = allVerdicts.every((verdict) => verdict.verdict === "approve");

  let overallStatus: McqValidatorSummary["overallStatus"] = "mixed";

  if (approved) {
    overallStatus = "approved";
  } else if (rejected) {
    overallStatus = "rejected";
  }

  return {
    summary: {
      overallStatus,
      topicSummaries: summaries,
    },
    usageTotals,
  };
}
