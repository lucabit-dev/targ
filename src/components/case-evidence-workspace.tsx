"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button, FieldLabel, Surface } from "@/components/ui/primitives";
import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";
import type { EvidenceKindValue, EvidenceSourceValue } from "@/lib/evidence/constants";
import { EVIDENCE_KIND_LABELS } from "@/lib/evidence/constants";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";
import { EvidenceInventory } from "@/components/evidence-inventory";
import { cn } from "@/lib/utils/cn";

type CaseEvidenceWorkspaceProps = {
  caseId: string;
  evidence: EvidenceViewModel[];
  latestDiagnosis?: DiagnosisSnapshotViewModel | null;
  onEvidenceChange?: (evidence: EvidenceViewModel[]) => void;
  /** Dense layout for slide-over; default is full inline page. */
  variant?: "page" | "panel";
};

const textEvidenceKinds: EvidenceKindValue[] = [
  "log",
  "error_text",
  "terminal",
  "note",
  "code",
];

const sourceOptions: EvidenceSourceValue[] = ["paste", "manual_note"];

const EVIDENCE_KIND_HELP: Record<EvidenceKindValue, string> = {
  log: "Best for service logs, stack traces, and timestamped failures.",
  error_text: "Best for one-off error messages copied from the UI or tooling.",
  terminal: "Best for shell output, CI logs, and reproduction commands.",
  note: "Best for human context: what changed, what you expected, what you tried.",
  code: "Best for snippets, diffs, query text, or suspicious implementation details.",
  screenshot: "Best for broken states, visible errors, and UI regressions.",
};

type EvidenceListResponse = {
  evidence: EvidenceViewModel[];
};

export function CaseEvidenceWorkspace({
  caseId,
  evidence,
  latestDiagnosis = null,
  onEvidenceChange,
  variant = "page",
}: CaseEvidenceWorkspaceProps) {
  const isPanel = variant === "panel";
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [textKind, setTextKind] = useState<EvidenceKindValue>("log");
  const [textSource, setTextSource] = useState<EvidenceSourceValue>("paste");
  const [textValue, setTextValue] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [screenshotContext, setScreenshotContext] = useState("");
  const [isSavingText, setIsSavingText] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);

  const hasParsingEvidence = evidence.some(
    (item) => item.ingestStatus === "parsing"
  );
  const hasSelectedImages = selectedFiles.some((file) =>
    file.type.startsWith("image/")
  );
  const newEvidenceSinceDiagnosisCount =
    latestDiagnosis === null
      ? 0
      : evidence.filter(
          (item) => item.caseEvidenceVersion > latestDiagnosis.caseEvidenceVersion
        ).length;
  const referencedEvidenceIds = latestDiagnosis
    ? latestDiagnosis.claimReferences
        .flatMap((item) => (item.evidenceId ? [item.evidenceId] : []))
        .filter((value, index, all) => all.indexOf(value) === index)
    : [];

  const refreshEvidence = useCallback(async () => {
    const response = await fetch(`/api/cases/${caseId}/evidence`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error("Could not refresh evidence.");
    }

    const data = (await response.json()) as EvidenceListResponse;
    onEvidenceChange?.(data.evidence);
  }, [caseId, onEvidenceChange]);

  useEffect(() => {
    if (!hasParsingEvidence) {
      return;
    }

    const intervalId = window.setInterval(() => {
      refreshEvidence().catch(() => undefined);
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasParsingEvidence, refreshEvidence]);

  async function handleAddTextEvidence() {
    setError(null);
    setFeedback(null);
    setIsSavingText(true);

    try {
      const response = await fetch(`/api/cases/${caseId}/evidence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: textKind,
          source: textSource,
          originalName:
            textSource === "manual_note" ? "Manual note" : "Pasted evidence",
          rawText: textValue,
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
        setError(data?.error ?? "Could not add evidence.");
        return;
      }

      setTextValue("");
      setFeedback(
        textSource === "manual_note"
          ? "Manual note added. It is now part of the case evidence set."
          : "Pasted evidence saved. Targ is parsing it now."
      );
      await refreshEvidence();
      router.refresh();
    } catch {
      setError("Request failed. Try again.");
    } finally {
      setIsSavingText(false);
    }
  }

  async function handleUploadFiles() {
    if (selectedFiles.length === 0) {
      return;
    }

    setError(null);
    setFeedback(null);
    setIsUploadingFiles(true);

    try {
      let uploadedImageCount = 0;
      for (const file of selectedFiles) {
        if (file.type.startsWith("image/")) {
          uploadedImageCount += 1;
        }

        const presignResponse = await fetch("/api/uploads/presign", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            caseId,
            originalName: file.name,
            mimeType: file.type,
            size: file.size,
          }),
        });

        const presignData = (await presignResponse.json().catch(() => null)) as
          | {
              error?: string;
              uploadUrl?: string;
            }
          | null;

        if (!presignResponse.ok || !presignData?.uploadUrl) {
          setError(presignData?.error ?? `Could not prepare ${file.name}.`);
          return;
        }

        const formData = new FormData();
        formData.append("file", file);

        const uploadResponse = await fetch(presignData.uploadUrl, {
          method: "POST",
          body: formData,
        });

        const uploadData = (await uploadResponse.json().catch(() => null)) as
          | { error?: string }
          | null;

        if (!uploadResponse.ok) {
          setError(uploadData?.error ?? `Could not upload ${file.name}.`);
          return;
        }
      }

      if (screenshotContext.trim().length > 0 && hasSelectedImages) {
        const noteResponse = await fetch(`/api/cases/${caseId}/evidence`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            kind: "note",
            source: "manual_note",
            originalName: "Screenshot context",
            rawText: screenshotContext.trim(),
          }),
        });

        const noteData = (await noteResponse.json().catch(() => null)) as
          | { error?: string }
          | null;

        if (!noteResponse.ok) {
          setError(
            noteData?.error ??
              "Files uploaded, but the screenshot context note could not be saved."
          );
          return;
        }
      }

      setSelectedFiles([]);
      setScreenshotContext("");
      setFeedback(
        uploadedImageCount > 0
          ? screenshotContext.trim().length > 0
            ? "Files uploaded. Targ linked your screenshot note and will use it in the next analysis."
            : "Files uploaded. Screenshots are stored, but a short note about what matters will make the next analysis sharper."
          : "Files uploaded. Targ is parsing anything it can from them now."
      );
      await refreshEvidence();
      router.refresh();
    } catch {
      setError("Upload failed. Check connection and try again.");
    } finally {
      setIsUploadingFiles(false);
    }
  }

  return (
    <div className={isPanel ? "space-y-5" : "space-y-6"}>
      <Surface
        tone="base"
        padding={isPanel ? "sm" : "md"}
        className={cn(
          "border border-[var(--color-border-subtle)]",
          !isPanel && "sm:p-6"
        )}
      >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              {isPanel ? (
                <>
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                    Add evidence
                  </h2>
                  <p className="mt-1.5 text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
                    Paste, upload, or note. Parse state and warnings live in
                    inventory below.
                  </p>
                </>
              ) : (
                <>
                  <h2 className="targ-page-title text-[var(--color-text-primary)]">
                    Evidence
                  </h2>
                  <p className="mt-2 targ-body max-w-2xl">
                    Paste or upload the strongest proof you have. Targ normalizes
                    what it can, keeps warnings on the record, and leaves the rest visible.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className={cn("rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/80 bg-[rgba(255,255,255,0.02)] px-3 py-3", isPanel ? "mt-4" : "mt-5")}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
              What works best here
            </p>
            <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
              {EVIDENCE_KIND_HELP[textKind]}
            </p>
            {latestDiagnosis ? (
              <p className="mt-2 text-[11px] leading-[17px] text-[var(--color-text-muted)]">
                {newEvidenceSinceDiagnosisCount > 0
                  ? `${newEvidenceSinceDiagnosisCount} item${newEvidenceSinceDiagnosisCount === 1 ? "" : "s"} were added after the latest diagnosis.`
                  : "The current inventory matches the latest diagnosis snapshot."}
              </p>
            ) : (
              <p className="mt-2 text-[11px] leading-[17px] text-[var(--color-text-muted)]">
                There is no diagnosis yet, so every item you add can shape the first read.
              </p>
            )}
          </div>

          <div
            className={cn("grid gap-4 sm:grid-cols-2", isPanel ? "mt-4" : "mt-6")}
          >
            <div>
              <FieldLabel>Evidence type</FieldLabel>
              <select
                value={textKind}
                onChange={(event) =>
                  setTextKind(event.target.value as EvidenceKindValue)
                }
                className="targ-select"
              >
                {textEvidenceKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {EVIDENCE_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <FieldLabel>Source</FieldLabel>
              <select
                value={textSource}
                onChange={(event) =>
                  setTextSource(event.target.value as EvidenceSourceValue)
                }
                className="targ-select"
              >
                {sourceOptions.map((source) => (
                  <option key={source} value={source}>
                    {source === "paste" ? "Paste" : "Manual note"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <textarea
            value={textValue}
            onChange={(event) => setTextValue(event.target.value)}
            placeholder="Stack trace, log tail, command output, note, or snippet."
            className={cn(
              "targ-textarea mt-4",
              isPanel ? "min-h-[140px]" : "min-h-[220px]"
            )}
          />

          <Surface tone="base" padding="sm" className={cn("border-dashed", isPanel ? "mt-4" : "mt-5")}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div
                  className={cn(
                    isPanel
                      ? "text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]"
                      : "targ-section-title text-[var(--color-text-primary)]"
                  )}
                >
                  Files
                </div>
                <div className={cn("mt-1", isPanel ? "text-[12px] leading-[17px] text-[var(--color-text-secondary)]" : "targ-body")}>
                  {isPanel
                    ? "Logs, images, or binaries. Images usually need a short manual note."
                    : "Attach logs, images, or binaries. Add a short note when the screenshot matters more than the pixels."}
                </div>
              </div>
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
                Choose files
              </Button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) =>
                setSelectedFiles(Array.from(event.target.files ?? []))
              }
            />

            {selectedFiles.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {selectedFiles.map((file) => (
                  <button
                    key={`${file.name}-${file.size}`}
                    type="button"
                    onClick={() =>
                      setSelectedFiles((current) =>
                        current.filter(
                          (item) =>
                            !(item.name === file.name && item.size === file.size)
                        )
                      )
                    }
                    className="targ-chip targ-chip-subtle"
                  >
                    {file.name} ×
                  </button>
                ))}
              </div>
            ) : null}

            {hasSelectedImages ? (
              <div className="mt-4 rounded-[var(--radius-sm)] border border-[rgba(211,163,90,0.2)] bg-[rgba(211,163,90,0.06)] px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-state-warning)]">
                  Screenshot context
                </p>
                <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                  Screenshots are stored first, then interpreted through the strongest note you give Targ about what matters most.
                </p>
                <textarea
                  value={screenshotContext}
                  onChange={(event) => setScreenshotContext(event.target.value)}
                  placeholder="What in the screenshot matters most? Visible error, broken state, missing element, wrong value, console line, or exact step."
                  className="targ-textarea mt-3 min-h-[110px]"
                />
              </div>
            ) : null}
          </Surface>

          {error ? (
            <div className="targ-callout-critical mt-4 text-sm">{error}</div>
          ) : null}
          {feedback ? (
            <div className="mt-4 rounded-[var(--radius-sm)] border border-[rgba(95,168,166,0.24)] bg-[rgba(95,168,166,0.08)] px-3 py-3 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
              {feedback}
            </div>
          ) : null}

          <div
            className={cn(
              "flex flex-col gap-3 sm:flex-row",
              isPanel ? "mt-4" : "mt-5"
            )}
          >
            <Button
              onClick={handleAddTextEvidence}
              disabled={isSavingText || textValue.trim().length === 0}
            >
              {isSavingText ? "Saving…" : "Add pasted item"}
            </Button>
            <Button
              variant="secondary"
              onClick={handleUploadFiles}
              disabled={isUploadingFiles || selectedFiles.length === 0}
            >
              {isUploadingFiles ? "Uploading…" : "Upload files"}
            </Button>
          </div>
      </Surface>

      <div>
        <div className={isPanel ? "mb-3" : "mb-4"}>
          {isPanel ? (
            <>
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                Inventory
              </h2>
              <p className="mt-1.5 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                Kind, ingest status, summary, parser notices.
              </p>
            </>
          ) : (
            <>
              <h2 className="targ-page-title text-[var(--color-text-primary)]">
                Inventory
              </h2>
              <p className="mt-2 targ-body">
                See what Targ already used, what is newer than the last diagnosis,
                and which files still need review.
              </p>
            </>
          )}
        </div>
        <EvidenceInventory
          evidence={evidence}
          highlightedEvidenceIds={referencedEvidenceIds}
          latestDiagnosisCaseEvidenceVersion={latestDiagnosis?.caseEvidenceVersion ?? null}
        />
      </div>
    </div>
  );
}
