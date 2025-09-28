# Clarytix LLM Prototype

This package hosts a prototype service for topic generation from book chapters using the OpenAI API. The workflow is intentionally simple so that we can focus on end-to-end evaluation of the LLM experience before layering on parsing or chunking logic.

## Goals

- Accept a full book PDF upload from the user alongside a target chapter number and title.
- Send the untouched PDF directly to OpenAI's file ingestion endpoint.
- Ask the model to extract 6-10 key topics for the requested chapter and return them in a structured JSON format.

## High-Level Architecture

1. **Web UI (Next.js App Router)** – collects the PDF, chapter metadata, and displays generated topics.
2. **API Route (`app/api/topics`)** – uploads (or reuses a cached upload of) the PDF with OpenAI's file storage and then orchestrates a structured Responses API call backed by the file-search tool so only relevant chapter content is retrieved.
3. **API Route (`app/api/mcqs`)** – takes the generated topics and asks OpenAI to create MCQs that satisfy the rubric, returning a downloadable CSV.
4. **OpenAI SDK Wrapper (`lib/openai.ts`)** – centralizes client instantiation and environment handling.

## Implementation Notes

- The API request uses the Responses API with a `json_schema` response format to guarantee structured output.
- Uploads are cached in-memory for one hour to avoid repeatedly re-ingesting the same book during a session.
- File-search keeps Responses well below token-per-minute limits by letting the model retrieve only the relevant chapter excerpts.
- The frontend surfaces request states (idle, loading, error) and renders the topic list.
- MCQ generation uses the same vector store for retrieval, producing a dedicated question set for each suggested topic and streaming the combined results back as a CSV download.
- Environment variable: `OPENAI_API_KEY` must be configured before running the app.

## Next Steps

- Add retries/backoff for transient OpenAI errors.
- Persist successful topic splits for later reuse.
- Gate file size and page count to keep requests inside model limits.
