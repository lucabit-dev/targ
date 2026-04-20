"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import {
  ACTION_DRAFT_STATUS_LABELS,
  ACTION_DRAFT_TYPE_LABELS,
} from "@/lib/analysis/constants";
import type { ActionDraftViewModel } from "@/lib/analysis/view-model";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";
import { Button, Chip } from "@/components/ui/primitives";
import { formatRelativeDate } from "@/lib/utils/format";

type DraftReviewSheetProps = {
  draft: ActionDraftViewModel | null;
  evidence: EvidenceViewModel[];
  currentDiagnosisId?: string | null;
  isOpen: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSave: () => Promise<void>;
};

const TYPE_CONTEXT: Record<ActionDraftViewModel["type"], string> = {
  fix: "Implementation or verification—take to your editor or pipeline.",
  investigation: "Discovery before you lock a fix.",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-[var(--color-border-subtle)] pb-6 last:border-0 last:pb-0">
      <h3 className="targ-micro font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function DraftReviewSheet({
  draft,
  evidence,
  currentDiagnosisId = null,
  isOpen,
  isSaving,
  onClose,
  onSave,
}: DraftReviewSheetProps) {
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!isOpen || !draft) {
    return null;
  }

  const linkedEvidence = evidence.filter((item) =>
    draft.linkedEvidenceIds.includes(item.id)
  );

  const isSaved = draft.status === "saved";
  const isStale = currentDiagnosisId !== null && draft.diagnosisSnapshotId !== currentDiagnosisId;

  function handleClose() {
    setSaveError(null);
    onClose();
  }

  async function handleSave() {
    setSaveError(null);
    try {
      await onSave();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save draft."
      );
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-[rgba(0,0,0,0.08)] transition-colors duration-[var(--motion-base)]">
      <div
        role="presentation"
        className="absolute inset-0 z-0 cursor-default"
        onClick={handleClose}
      />
      <div className="relative z-10 flex h-full w-full max-w-[480px] flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] shadow-[-12px_0_40px_rgba(0,0,0,0.18)]">
        <header className="shrink-0 border-b border-[var(--color-border-subtle)] px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="targ-micro font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                Action draft
              </p>
              <h2 className="mt-2 text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-[var(--color-text-primary)]">
                {draft.title}
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Chip>{ACTION_DRAFT_TYPE_LABELS[draft.type]}</Chip>
                <span className="targ-meta text-[var(--color-text-muted)]">·</span>
                <span className="targ-meta text-[var(--color-text-secondary)]">
                  {draft.urgency}
                </span>
                {isSaved ? (
                  <>
                    <span className="targ-meta text-[var(--color-text-muted)]">·</span>
                    <Chip tone="success">{ACTION_DRAFT_STATUS_LABELS.saved}</Chip>
                  </>
                ) : null}
              </div>
              <p className="mt-2 max-w-md targ-meta leading-[17px] text-[var(--color-text-muted)]">
                {TYPE_CONTEXT[draft.type]}
              </p>
              <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/80 bg-[rgba(255,255,255,0.02)] px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Draft status
                </p>
                <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                  {isStale
                    ? "This draft is older than the current diagnosis. Review the latest work plan before relying on it."
                    : isSaved
                      ? "This draft is saved on the case and aligned with the current diagnosis."
                      : "This draft is unsaved and tied to the current diagnosis snapshot."}
                </p>
              </div>
            </div>
            <Button variant="tertiary" type="button" onClick={handleClose}>
              Close
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-6">
          <div className="space-y-8">
            <Section title="Summary">
              <p className="targ-body text-[var(--color-text-secondary)]">
                {draft.summary}
              </p>
            </Section>

            <Section title="Why now">
              <p className="targ-body text-[var(--color-text-secondary)]">
                {draft.whyNow}
              </p>
            </Section>

            <Section title="Use this draft for">
              <ul className="list-disc space-y-2 pl-5 text-[14px] leading-[22px] text-[var(--color-text-secondary)]">
                <li>Engineer handoff when someone else needs the shortest credible path.</li>
                <li>Implementation checklist while you work through the diagnosis.</li>
                <li>Verification plan before you call the issue resolved.</li>
              </ul>
            </Section>

            <Section title="Steps">
              <ol className="list-none space-y-0 p-0">
                {draft.suggestedSteps.map((step, index) => (
                  <li
                    key={`${index}-${step}`}
                    className="flex gap-3 border-t border-[var(--color-border-subtle)] py-3 first:border-0 first:pt-0"
                  >
                    <span className="targ-micro mt-0.5 w-5 shrink-0 font-bold tabular-nums text-[var(--color-accent-primary)]">
                      {index + 1}
                    </span>
                    <span className="text-[14px] leading-[22px] text-[var(--color-text-secondary)]">
                      {step}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>

            {draft.risksOrUnknowns.length > 0 ? (
              <Section title="Risks & unknowns">
                <ul className="list-disc space-y-2 pl-5 text-[14px] leading-[22px] text-[var(--color-text-secondary)]">
                  {draft.risksOrUnknowns.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </Section>
            ) : null}

            <Section title="Grounded in">
              {linkedEvidence.length > 0 ? (
                <ul className="space-y-2">
                  {linkedEvidence.map((item) => (
                    <li
                      key={item.id}
                      className="text-[13px] leading-[20px] text-[var(--color-text-secondary)]"
                    >
                      <span className="font-medium text-[var(--color-text-primary)]">
                        {item.originalName}
                      </span>
                      {item.summary ? (
                        <span className="text-[var(--color-text-muted)]">
                          {" "}
                          — {item.summary}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="targ-meta text-[var(--color-text-muted)]">
                  No file-level links were persisted on this draft. It still comes
                  from the case evidence set, just without explicit file pinning here.
                </p>
              )}
            </Section>
          </div>
        </div>

        <footer className="shrink-0 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-5 py-4 sm:px-6">
          {isSaved ? (
            <div>
              <p className="text-sm font-medium text-[var(--color-state-success)]">
                Saved on this case
                {draft.savedAt ? (
                  <span className="font-normal text-[var(--color-text-muted)]">
                    {" "}
                    · {formatRelativeDate(draft.savedAt)}
                  </span>
                ) : null}
              </p>
              <p className="mt-2 targ-meta text-[var(--color-text-muted)]">
                Continue outside Targ. Reopen it from the case header anytime.
              </p>
              <Button type="button" className="mt-4 w-full sm:w-auto" onClick={handleClose}>
                Done
              </Button>
            </div>
          ) : (
            <div>
              <p className="targ-meta leading-[18px] text-[var(--color-text-muted)]">
                <span className="text-[var(--color-text-secondary)]">Save</span>{" "}
                pins this version on the case. Execution still happens outside Targ.
              </p>
              {saveError ? (
                <p className="targ-callout-critical mt-3 text-sm">{saveError}</p>
              ) : null}
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Button
                  type="button"
                  disabled={isSaving}
                  className="w-full sm:w-auto sm:px-6"
                  onClick={handleSave}
                >
                  {isSaving
                    ? "Saving…"
                    : isStale
                      ? "Save anyway"
                      : "Save draft on case"}
                </Button>
                <Button
                  variant="tertiary"
                  type="button"
                  className="w-full sm:w-auto"
                  onClick={handleClose}
                >
                  Close without saving
                </Button>
              </div>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
