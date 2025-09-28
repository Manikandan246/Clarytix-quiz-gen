"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useMemo,
  useState,
} from "react";

interface Topic {
  topic: string;
  description: string;
}

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB limit for safety.

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

    setIsGeneratingMcqs(true);
    setMcqError(null);
    setMcqStatus("Generating MCQ sets for each topic…");

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

      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        throw new Error(problem?.error ?? "Failed to generate MCQs.");
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `chapter-${chapterNumber}-mcqs.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);

      setMcqStatus("All MCQ sets generated and download started.");
    } catch (cause) {
      setMcqError(cause instanceof Error ? cause.message : "Unexpected error while creating MCQs.");
      setMcqStatus(null);
    } finally {
      setIsGeneratingMcqs(false);
    }
  }, [bookFingerprint, chapterNumber, chapterTitle, topics, vectorStoreId]);

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
