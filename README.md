# Clarytix LLM Prototype

This package hosts a prototype service for topic generation from book chapters using the OpenAI API. The workflow is intentionally simple so that we can focus on end-to-end evaluation of the LLM experience before layering on parsing or chunking logic.

## Goals

- Accept a full book PDF upload from the user alongside a target chapter number and title.
- Send the untouched PDF directly to OpenAI's file ingestion endpoint.
- Ask the model to extract 6-10 key topics for the requested chapter and return them in a structured JSON format.

## High-Level Architecture

1. **Web UI (Next.js App Router)** – collects the PDF, chapter metadata, and displays generated topics.
2. **API Route (`app/api/topics`)** – uploads (or reuses a cached upload of) the PDF with OpenAI's file storage and then orchestrates a structured Responses API call backed by the file-search tool so only relevant chapter content is retrieved (aiming for 3–8 topics per chapter).
3. **API Route (`app/api/mcqs`)** – queues MCQ generation/validation jobs and stores the resulting CSV once Claude approves the questions.
4. **API Route (`app/api/validate`)** – sends generated MCQs to Claude for automated verification before they are stored or surfaced.
5. **OpenAI SDK Wrapper (`lib/openai.ts`)** – centralizes client instantiation and environment handling.

## Implementation Notes

- The API request uses the Responses API with a `json_schema` response format to guarantee structured output.
- Uploads are cached in-memory for one hour to avoid repeatedly re-ingesting the same book during a session.
- File-search keeps Responses well below token-per-minute limits by letting the model retrieve only the relevant chapter excerpts.
- The frontend now requires a class (5–12) and loads subjects from Postgres (`GET /api/subjects?class=…`) before generating topics/MCQs.
- MCQ generation queues an asynchronous job (`POST /api/mcqs`), producing a dedicated question set (10–15 MCQs per topic) and storing the CSV server-side until validation finishes.
- After a job completes, the service upserts the chapter/topics/questions into Postgres (`chapters`, `topics`, `questions`) keyed by class and subject.
- The UI polls `/api/mcqs/status?jobId=…` and downloads the CSV from `/api/mcqs/result?jobId=…` when Claude approval completes. Token usage totals for OpenAI and Anthropic are exposed via the status endpoint for auditing.
- A validator endpoint integrates with Claude; MCQs are cross-checked per topic in batches. Rejected questions are automatically rewritten by the validator before CSV export, and server logs capture each replacement for troubleshooting.
- Environment variable: `OPENAI_API_KEY` must be configured before running the app.
- Environment variable: `ANTHROPIC_API_KEY` must be configured to enable MCQ validation.
- Environment variable: `DATABASE_URL` must point to the Postgres instance that hosts the `subjects` table.
  - The `subjects` table should expose `id`, `class` (integer), and either `subject_name` or `name`; results are ordered alphabetically per class.

## Next Steps

- Add retries/backoff for transient OpenAI errors.
- Persist successful topic splits for later reuse.
- Gate file size and page count to keep requests inside model limits.
