"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface Topic {
  topic: string;
  description: string;
}

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB limit for safety.

type JobStatus = "pending" | "processing" | "succeeded" | "failed";

export default function TopicSplitForm() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [chapterNumber, setChapterNumber] = useState(1);
  const [chapterTitle, setChapterTitle] = useState("");
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [vectorStoreId, setVectorStoreId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mcqStatus, setMcqStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGeneratingMcqs, setIsGeneratingMcqs] = useState(false);
  const [mcqError, setMcqError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [jobLogs, setJobLogs] = useState<string[]>([]);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fileLabel = useMemo(() => {
    if (!pdfFile) {
      return "No file selected";
    }
    const sizeMB = (pdfFile.size / (1024 * 1024)).toFixed(2);
    return `${pdfFile.name} • ${sizeMB} MB`;
  }, [pdfFile]);

  const bookFingerprint = useMemo(() => {
    if (!pdfFile) {
      return null;
    }
    return `${pdfFile.name}:${pdfFile.size}:${pdfFile.lastModified}`;
  }, [pdfFile]);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        setPdfFile(null);
        return;
      }

      if (file.type !== "application/pdf") {
        setError("Please upload a PDF file.");
        setPdfFile(null);
        return;
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        setError("The PDF must be 100 MB or smaller.");
        setPdfFile(null);
        return;
      }

      setError(null);
      setStatus(null);
      setMcqStatus(null);
      setMcqError(null);
      setTopics(null);
      setVectorStoreId(null);
      setPdfFile(file);
    },
    [],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!pdfFile) {
        setError("Attach a PDF before submitting.");
        return;
      }

      if (!chapterTitle.trim()) {
        setError("Enter a chapter title.");
        return;
      }

      setIsSubmitting(true);
      setTopics(null);
      setError(null);
      setStatus("Generating topics via OpenAI…");
      setMcqStatus(null);
      setMcqError(null);
      setVectorStoreId(null);

      const payload = new FormData();
      payload.append("pdf", pdfFile);
      payload.append("chapterNumber", String(chapterNumber));
      payload.append("chapterTitle", chapterTitle.trim());
      if (bookFingerprint) {
        payload.append("bookFingerprint", bookFingerprint);
      }

      try {
        const response = await fetch("/api/topics", {
          method: "POST",
          body: payload,
        });

        if (!response.ok) {
          const problem = await response.json().catch(() => null);
          throw new Error(problem?.error ?? "Failed to generate topics.");
        }

        const result = (await response.json()) as { topics: Topic[]; vectorStoreId?: string };
        setTopics(result.topics);
        setVectorStoreId(result.vectorStoreId ?? null);
        setStatus("Finished! Here are the topics the model suggested.");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unexpected error.");
        setStatus(null);
      } finally {
        setIsSubmitting(false);
      }
    },
    [bookFingerprint, chapterNumber, chapterTitle, pdfFile],
  );

  const handleDownloadMcqs = useCallback(async () => {
    if (!topics || topics.length === 0) {
      setMcqError("Generate topics before requesting MCQs.");
      return;
    }

    if (!vectorStoreId) {
      setMcqError("Missing reference to the uploaded book. Regenerate topics and try again.");
      return;
    }

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    setIsGeneratingMcqs(true);
    setMcqError(null);
    setMcqStatus("Queued MCQ generation job…");
    setJobId(null);
    setJobStatus(null);
    setJobLogs([]);

    try {
      const response = await fetch("/api/mcqs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chapterNumber,
          chapterTitle: chapterTitle.trim(),
          topics,
          vectorStoreId,
          bookFingerprint,
        }),
      });

      const payload = await response.json().catch(() => ({} as { jobId?: string; error?: string }));

      if (!response.ok || !payload?.jobId) {
        throw new Error(payload?.error ?? "Failed to queue MCQ generation.");
      }

      setJobId(payload.jobId);
      setJobStatus("pending");
      setMcqStatus("MCQ job queued. Validation in progress…");

      const poll = async () => {
        try {
          const statusResponse = await fetch(`/api/mcqs/status?jobId=${payload.jobId}`);
          const statusPayload = await statusResponse.json().catch(() => null);

          if (!statusResponse.ok || !statusPayload) {
            throw new Error(statusPayload?.error ?? "Unable to poll MCQ job status.");
          }

          setJobStatus(statusPayload.status as JobStatus);
          setJobLogs(Array.isArray(statusPayload.logs) ? statusPayload.logs : []);

          if (statusPayload.status === "succeeded") {
            setMcqStatus("Validation succeeded. Preparing download…");
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }

            const resultResponse = await fetch(`/api/mcqs/result?jobId=${payload.jobId}`);

            if (!resultResponse.ok) {
              const problem = await resultResponse
                .json()
                .catch(() => null);
              throw new Error(problem?.error ?? "Unable to retrieve MCQ results.");
            }

            const blob = await resultResponse.blob();
            const downloadUrl = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = downloadUrl;
            anchor.download = `chapter-${chapterNumber}-mcqs.csv`;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(downloadUrl);

            setMcqStatus("All MCQ sets generated and download started.");
            setIsGeneratingMcqs(false);
          } else if (statusPayload.status === "failed") {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setMcqError(statusPayload.error ?? "MCQ generation failed.");
            setMcqStatus(null);
            setIsGeneratingMcqs(false);
          } else {
            setMcqStatus(
              statusPayload.status === "processing"
                ? "Validation in progress…"
                : "Job queued…",
            );
          }
        } catch (error) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setMcqError(error instanceof Error ? error.message : "Unable to poll MCQ job.");
          setMcqStatus(null);
          setIsGeneratingMcqs(false);
        }
      };

      await poll();
      pollIntervalRef.current = setInterval(poll, 2000);
    } catch (cause) {
      setMcqError(cause instanceof Error ? cause.message : "Unexpected error while creating MCQs.");
      setMcqStatus(null);
      setIsGeneratingMcqs(false);
    }
  }, [bookFingerprint, chapterNumber, chapterTitle, topics, vectorStoreId]);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  return (
    <form className="form" onSubmit={handleSubmit}>
      <fieldset>
        <label htmlFor="pdf">Book PDF</label>
        <input
          id="pdf"
          type="file"
          accept="application/pdf"
          onChange={handleFileChange}
          disabled={isSubmitting}
        />
        <span className="status">{fileLabel}</span>
      </fieldset>

      <fieldset>
        <label htmlFor="chapterNumber">Chapter number</label>
        <input
          id="chapterNumber"
          type="number"
          min={1}
          value={chapterNumber}
          onChange={(event) => {
            const nextValue = Number.parseInt(event.target.value, 10);
            setChapterNumber(Number.isNaN(nextValue) ? 1 : Math.max(1, nextValue));
          }}
          disabled={isSubmitting}
          required
        />
      </fieldset>

      <fieldset>
        <label htmlFor="chapterTitle">Chapter title</label>
        <input
          id="chapterTitle"
          type="text"
          placeholder="e.g. Foundations of Data Analytics"
          value={chapterTitle}
          onChange={(event) => setChapterTitle(event.target.value)}
          disabled={isSubmitting}
          required
        />
      </fieldset>

      <div className="button-row">
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Sending to OpenAI…" : "Generate topics"}
        </button>
        {status && !error && <span className="status">{status}</span>}
        {error && <span className="status error">{error}</span>}
      </div>

      {topics && topics.length > 0 && (
        <div className="button-row">
          <button
            type="button"
            onClick={handleDownloadMcqs}
            disabled={isSubmitting || isGeneratingMcqs}
          >
            {isGeneratingMcqs ? "Generating MCQs…" : "Download MCQs (CSV)"}
          </button>
          {mcqStatus && !mcqError && <span className="status">{mcqStatus}</span>}
          {mcqError && <span className="status error">{mcqError}</span>}
        </div>
      )}

      {jobStatus && (
        <div className="status" aria-live="polite">
          Job status: {jobStatus}
          {jobLogs.length > 0 && (
            <>
              <br />
              Last update: {jobLogs[jobLogs.length - 1]}
            </>
          )}
        </div>
      )}

      {topics && topics.length > 0 && (
        <section className="topic-grid" aria-live="polite">
          {topics.map((topic) => (
            <article key={topic.topic} className="topic-card">
              <h3>{topic.topic}</h3>
              <p>{topic.description}</p>
            </article>
          ))}
        </section>
      )}
    </form>
  );
}
