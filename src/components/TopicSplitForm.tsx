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

interface SubjectOption {
  id: number;
  name: string;
}

interface SyllabusOption {
  id: number;
  name: string;
}

interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface StatusResponse {
  status: JobStatus;
  logs?: string[];
  error?: string | null;
  openAiUsage?: TokenUsageTotals;
  anthropicUsage?: TokenUsageTotals;
}

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB limit for safety.
const CLASS_LEVELS = [5, 6, 7, 8, 9, 10, 11, 12] as const;

type JobStatus = "pending" | "processing" | "succeeded" | "failed";

export default function TopicSplitForm() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [chapterNumber, setChapterNumber] = useState<string>("");
  const [chapterTitle, setChapterTitle] = useState("");
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [vectorStoreId, setVectorStoreId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mcqStatus, setMcqStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGeneratingMcqs, setIsGeneratingMcqs] = useState(false);
  const [mcqError, setMcqError] = useState<string | null>(null);
  const [selectedClass, setSelectedClass] = useState<number | null>(null);
  const [availableSubjects, setAvailableSubjects] = useState<SubjectOption[]>([]);
  const [subjectsLoading, setSubjectsLoading] = useState(false);
  const [subjectsError, setSubjectsError] = useState<string | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<SubjectOption | null>(null);
  const [availableSyllabuses, setAvailableSyllabuses] = useState<SyllabusOption[]>([]);
  const [syllabusesLoading, setSyllabusesLoading] = useState(false);
  const [syllabusesError, setSyllabusesError] = useState<string | null>(null);
  const [selectedSyllabus, setSelectedSyllabus] = useState<SyllabusOption | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [jobLogs, setJobLogs] = useState<string[]>([]);
  const [openAiUsage, setOpenAiUsage] = useState<TokenUsageTotals | null>(null);
  const [anthropicUsage, setAnthropicUsage] = useState<TokenUsageTotals | null>(null);

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

  const resetJobPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

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

      if (!chapterNumber.trim()) {
        setError("Enter a chapter number.");
        return;
      }

      if (selectedClass === null) {
        setError("Select a class before generating topics.");
        return;
      }

      if (!selectedSyllabus) {
        setError("Select a syllabus before generating topics.");
        return;
      }

      if (!chapterNumber.trim()) {
        setError("Enter a chapter number.");
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
      payload.append("chapterNumber", chapterNumber.trim());
      payload.append("chapterTitle", chapterTitle.trim());
      payload.append("classLevel", String(selectedClass));
      payload.append("syllabusName", selectedSyllabus.name);
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
    [
      bookFingerprint,
      chapterNumber,
      chapterTitle,
      pdfFile,
      selectedClass,
      selectedSyllabus,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    setSubjectsLoading(true);
    setSubjectsError(null);
    setAvailableSubjects([]);
    setSelectedSubject(null);

    fetch(`/api/subjects${selectedClass !== null ? `?class=${selectedClass}` : ""}`)
      .then(async (response) => {
        if (!response.ok) {
          const problem = await response.json().catch(() => null);
          throw new Error(problem?.error ?? "Failed to fetch subjects.");
        }
        return response.json() as Promise<{ subjects?: SubjectOption[] }>;
      })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const subjects = Array.isArray(data.subjects) ? data.subjects : [];
        setAvailableSubjects(subjects);
        if (subjects.length === 1) {
          setSelectedSubject(subjects[0]);
        }
      })
      .catch((subjectError) => {
        if (cancelled) {
          return;
        }
        console.error("[subjects]", subjectError);
        setSubjectsError(
          subjectError instanceof Error ? subjectError.message : "Unable to load subjects.",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setSubjectsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedClass]);

  useEffect(() => {
    if (selectedClass === null) {
      setAvailableSyllabuses([]);
      setSelectedSyllabus(null);
      setSyllabusesError(null);
      setSyllabusesLoading(false);
      return;
    }

    let cancelled = false;
    setSyllabusesLoading(true);
    setSyllabusesError(null);
    setAvailableSyllabuses([]);
    setSelectedSyllabus(null);

    fetch("/api/syllabus")
      .then(async (response) => {
        if (!response.ok) {
          const problem = await response.json().catch(() => null);
          throw new Error(problem?.error ?? "Failed to fetch syllabuses.");
        }
        return response.json() as Promise<{ syllabuses?: SyllabusOption[] }>;
      })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const syllabuses = Array.isArray(data.syllabuses) ? data.syllabuses : [];
        setAvailableSyllabuses(syllabuses);
        if (syllabuses.length === 1) {
          setSelectedSyllabus(syllabuses[0]);
        }
      })
      .catch((syllabusError) => {
        if (cancelled) {
          return;
        }
        console.error("[syllabus]", syllabusError);
        setSyllabusesError(
          syllabusError instanceof Error ? syllabusError.message : "Unable to load syllabuses.",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setSyllabusesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedClass]);

  const handleDownloadMcqs = useCallback(async () => {
    if (!topics || topics.length === 0) {
      setMcqError("Generate topics before requesting MCQs.");
      return;
    }

    if (!vectorStoreId) {
      setMcqError("Missing reference to the uploaded book. Regenerate topics and try again.");
      return;
    }

    if (selectedClass === null) {
      setMcqError("Select a class before generating MCQs.");
      return;
    }

    if (!selectedSubject) {
      setMcqError("Select a subject before generating MCQs.");
      return;
    }

    if (!selectedSyllabus) {
      setMcqError("Select a syllabus before generating MCQs.");
      return;
    }

    resetJobPolling();
    setIsGeneratingMcqs(true);
    setMcqError(null);
    setMcqStatus(`Queued MCQ generation job for Class ${selectedClass} – ${selectedSubject.name}…`);
    setJobId(null);
    setJobStatus(null);
      setJobLogs([]);
      setOpenAiUsage(null);
      setAnthropicUsage(null);

      try {
        const response = await fetch("/api/mcqs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chapterNumber: Number.parseInt(chapterNumber.trim(), 10),
          chapterTitle: chapterTitle.trim(),
          topics,
          vectorStoreId,
          bookFingerprint,
          classLevel: selectedClass,
          subject: {
            id: selectedSubject.id,
            name: selectedSubject.name,
          },
          syllabus: {
            id: selectedSyllabus.id,
            name: selectedSyllabus.name,
          },
        }),
      });

      const payload = await response
        .json()
        .catch(() => ({} as { jobId?: string; error?: string }));

      if (!response.ok || !payload?.jobId) {
        throw new Error(payload?.error ?? "Failed to queue MCQ generation.");
      }

      setJobId(payload.jobId);
      setJobStatus("pending");

      const poll = async () => {
        try {
          const statusResponse = await fetch(`/api/mcqs/status?jobId=${payload.jobId}`);
          const statusPayload = (await statusResponse.json().catch(() => null)) as
            | (StatusResponse & { logs?: string[] })
            | null;

          if (!statusResponse.ok || !statusPayload) {
            throw new Error(statusPayload?.error ?? "Unable to poll MCQ job status.");
          }

          setJobStatus(statusPayload.status);
          setJobLogs(Array.isArray(statusPayload.logs) ? statusPayload.logs : []);
          setOpenAiUsage(statusPayload.openAiUsage ?? null);
          setAnthropicUsage(statusPayload.anthropicUsage ?? null);

          if (statusPayload.status === "succeeded") {
            const openAiTotal = statusPayload.openAiUsage?.totalTokens ?? 0;
            const anthropicTotal = statusPayload.anthropicUsage?.totalTokens ?? 0;
            setMcqStatus(
              `Validation succeeded. Tokens — OpenAI ${openAiTotal}, Anthropic ${anthropicTotal}. Preparing download…`,
            );
            resetJobPolling();

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
            resetJobPolling();
            setMcqError(statusPayload.error ?? "MCQ generation failed.");
            setMcqStatus(null);
            setIsGeneratingMcqs(false);
          } else {
            setMcqStatus(
              statusPayload.status === "processing"
                ? `Validation in progress for Class ${selectedClass} – ${selectedSubject.name}…`
                : "Job queued…",
            );
          }
        } catch (cause) {
          resetJobPolling();
          setMcqError(cause instanceof Error ? cause.message : "Unable to poll MCQ job.");
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
  }, [
    bookFingerprint,
    chapterNumber,
    chapterTitle,
    resetJobPolling,
    selectedClass,
    selectedSubject,
    selectedSyllabus,
    topics,
    vectorStoreId,
  ]);

  useEffect(() => {
    return () => {
      resetJobPolling();
    };
  }, [resetJobPolling]);

  return (
    <form className="form" onSubmit={handleSubmit}>
      <fieldset>
        <label>Class</label>
        <div className="button-row wrap">
          {CLASS_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={level === selectedClass ? "selected" : ""}
              onClick={() => {
                setSelectedClass(level);
                setError(null);
                setMcqError(null);
                setSelectedSyllabus(null);
                setAvailableSyllabuses([]);
                setSyllabusesError(null);
              }}
              disabled={isSubmitting}
            >
              Class {level}
            </button>
          ))}
        </div>
      </fieldset>

      {selectedClass !== null && (
        <fieldset>
          <label>Syllabus</label>
          {syllabusesLoading && <span className="status">Loading syllabuses…</span>}
          {syllabusesError && <span className="status error">{syllabusesError}</span>}
          {!syllabusesLoading && !syllabusesError && availableSyllabuses.length === 0 && (
            <span className="status">No syllabuses found.</span>
          )}
          {availableSyllabuses.length > 0 && (
            <select
              value={selectedSyllabus?.id ?? ""}
              onChange={(event) => {
                const option = availableSyllabuses.find(
                  (entry) => entry.id === Number.parseInt(event.target.value, 10),
                );
                if (option) {
                  setSelectedSyllabus(option);
                  setError(null);
                  setMcqError(null);
                }
              }}
              disabled={isSubmitting}
              className="select-compact"
            >
              <option value="" disabled>
                Select a syllabus
              </option>
              {availableSyllabuses.map((syllabus) => (
                <option key={syllabus.id} value={syllabus.id}>
                  {syllabus.name}
                </option>
              ))}
            </select>
          )}
        </fieldset>
      )}

      <fieldset>
        <label>Subject</label>
        {subjectsLoading && <span className="status">Loading subjects…</span>}
        {subjectsError && <span className="status error">{subjectsError}</span>}
        {!subjectsLoading && !subjectsError && availableSubjects.length === 0 && (
          <span className="status">No subjects found.</span>
        )}
        {availableSubjects.length > 0 && (
          <select
            value={selectedSubject?.id ?? ""}
            onChange={(event) => {
              const subject = availableSubjects.find(
                (option) => option.id === Number.parseInt(event.target.value, 10),
              );
              if (subject) {
                setSelectedSubject(subject);
                setMcqError(null);
              }
            }}
            disabled={isSubmitting}
            className="select-compact"
          >
            <option value="" disabled>
              Select a subject
            </option>
            {availableSubjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </select>
        )}
      </fieldset>

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
          type="text"
          inputMode="numeric"
          pattern="\\d*"
          placeholder="e.g. 1"
          value={chapterNumber}
          onChange={(event) => {
            const raw = event.target.value.replace(/[^0-9]/g, "");
            setChapterNumber(raw);
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
        <button type="submit" disabled={isSubmitting || selectedClass === null}>
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

      {jobStatus && (
        <div className="status" aria-live="polite">
          Job status: {jobStatus}
          {jobLogs.length > 0 && (
            <>
              <br />
              Last update: {jobLogs[jobLogs.length - 1]}
            </>
          )}
          {openAiUsage && (
            <>
              <br />
              OpenAI tokens — input: {openAiUsage.inputTokens}, output: {openAiUsage.outputTokens}, total: {openAiUsage.totalTokens}
            </>
          )}
          {anthropicUsage && (
            <>
              <br />
              Anthropic tokens — input: {anthropicUsage.inputTokens}, output: {anthropicUsage.outputTokens}, total: {anthropicUsage.totalTokens}
            </>
          )}
        </div>
      )}
    </form>
  );
}
