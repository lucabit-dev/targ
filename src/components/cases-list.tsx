import { Link2 } from "lucide-react";
import Link from "next/link";

import { Chip, Surface } from "@/components/ui/primitives";
import { DIAGNOSIS_CONFIDENCE_LABELS } from "@/lib/analysis/constants";
import {
  CASE_LIST_CONFIDENCE_CHIP,
  getCaseListStatusLabel,
} from "@/lib/case-list-status";
import { cn } from "@/lib/utils/cn";
import { formatRelativeDate } from "@/lib/utils/format";

export type CaseListItem = {
  id: string;
  title: string;
  workflowState: string;
  analysisState: string;
  draftState?: string;
  userProblemStatement?: string;
  severity?: string | null;
  confidence?: string | null;
  updatedAt: Date | string;
  statusLabel?: string;
  evidenceCount?: number;
  /// `owner/repo` when the case is scoped to a repo (Phase 2.4). Rendered as
  /// a subtle chip so users can see at a glance which cases already have a
  /// code-context scope.
  repoFullName?: string | null;
};

type CasesListProps = {
  cases: CaseListItem[];
  /** Row id to mark as the suggested next open (triage); omit on secondary lists. */
  nextCaseId?: string | null;
  emptyTitle: string;
  emptyBody: string;
  motionKey?: number;
};

function clampLine(text: string, max: number) {
  const t = text.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function deriveCaseListContext(
  title: string,
  statement: string | undefined | null
): string | null {
  const raw = statement?.trim();
  if (!raw) {
    return null;
  }

  const collapsed = raw.replace(/\s+/g, " ").trim();
  const titleNorm = title.trim().replace(/\s+/g, " ").toLowerCase();
  const firstLine = (raw.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  const firstLower = firstLine.toLowerCase();
  const titleTrim = title.trim();

  const sameOpening =
    firstLower === titleNorm ||
    (titleTrim.length >= 24 &&
      firstLine.slice(0, Math.min(72, titleTrim.length)) ===
        titleTrim.slice(0, Math.min(72, titleTrim.length)));

  if (sameOpening) {
    const rest = raw
      .split("\n")
      .slice(1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (rest.length > 8) {
      return clampLine(rest, 96);
    }
    return null;
  }

  return clampLine(collapsed, 96);
}

function deriveFallbackSubline(
  currentCase: CaseListItem,
  evidenceCount: number
): string | null {
  if (evidenceCount === 0 && currentCase.analysisState === "NOT_STARTED") {
    return "Add the first evidence slice before asking Targ for a diagnosis.";
  }

  if (currentCase.analysisState === "ANALYZING") {
    return "Targ is reading the current evidence set now.";
  }

  if (currentCase.analysisState === "FAILED") {
    return "The last diagnosis run failed. Re-run it or sharpen the evidence.";
  }

  if (currentCase.analysisState === "NEEDS_INPUT") {
    return "A clarifying answer is blocking the next diagnosis step.";
  }

  if (currentCase.analysisState === "READY") {
    return currentCase.draftState === "READY"
      ? "Diagnosis and handoff draft are ready on the case."
      : "Diagnosis is ready; open the case for the recommended next move.";
  }

  if (currentCase.analysisState === "NOT_STARTED" && evidenceCount > 0) {
    return "Evidence is in. Run analysis when you want the first diagnosis.";
  }

  if (currentCase.draftState === "READY") {
    return "Draft is waiting for review and save.";
  }

  if (currentCase.workflowState === "RESOLVED") {
    return "Marked resolved.";
  }

  return null;
}

function resolveStatusLabel(currentCase: CaseListItem) {
  if (currentCase.statusLabel) {
    return currentCase.statusLabel;
  }

  return getCaseListStatusLabel(currentCase);
}

function rowAccentClass(analysisState: string) {
  switch (analysisState) {
    case "NEEDS_INPUT":
      return "bg-[var(--color-state-warning)]";
    case "ANALYZING":
      return "bg-[var(--color-accent-primary)]";
    case "FAILED":
      return "bg-[var(--color-state-critical)]";
    case "READY":
      return "bg-[var(--color-state-success)]";
    default:
      return "bg-[rgba(255,255,255,0.1)]";
  }
}

function statusChipClass(currentCase: CaseListItem) {
  if (currentCase.draftState === "READY") {
    return "border-[rgba(111,175,123,0.18)] bg-[rgba(111,175,123,0.12)] text-[var(--color-state-success)]";
  }

  switch (currentCase.analysisState) {
    case "NEEDS_INPUT":
      return "border-[rgba(211,163,90,0.18)] bg-[rgba(211,163,90,0.12)] text-[var(--color-state-warning)]";
    case "ANALYZING":
      return "border-[rgba(95,168,166,0.18)] bg-[rgba(95,168,166,0.12)] text-[var(--color-accent-primary)]";
    case "FAILED":
      return "border-[rgba(209,107,107,0.18)] bg-[rgba(209,107,107,0.12)] text-[var(--color-state-critical)]";
    case "READY":
      return "border-[rgba(111,175,123,0.18)] bg-[rgba(111,175,123,0.12)] text-[var(--color-state-success)]";
    default:
      return "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[var(--color-text-secondary)]";
  }
}

function subtleMetaChipClass() {
  return "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[var(--color-text-muted)]";
}

function severityChipClass(severity: string | null | undefined) {
  if (severity === "CRITICAL") {
    return "border-[rgba(209,107,107,0.18)] bg-[rgba(209,107,107,0.12)] text-[var(--color-state-critical)]";
  }

  return "border-[rgba(211,163,90,0.18)] bg-[rgba(211,163,90,0.12)] text-[var(--color-state-warning)]";
}

function confidenceChipClass() {
  return "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[var(--color-text-secondary)]";
}

function nextUpChipClass() {
  return "border-[rgba(95,168,166,0.16)] bg-[rgba(95,168,166,0.1)] text-[var(--color-accent-primary)]";
}

function formatEvidenceLabel(count: number) {
  if (count === 0) {
    return "No evidence";
  }

  if (count === 1) {
    return "1 item";
  }

  return `${count} items`;
}

function formatSeverityLabel(severity: string) {
  if (severity === "CRITICAL") {
    return "Critical";
  }

  return "High";
}

export function CasesList({
  cases,
  nextCaseId,
  emptyTitle,
  emptyBody,
  motionKey = 0,
}: CasesListProps) {
  if (cases.length === 0) {
    return (
      <Surface
        tone="raised"
        padding="none"
        className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-5 py-8 text-center sm:px-8 sm:py-9"
      >
        <h2 className="targ-section-title text-[var(--color-text-primary)]">
          {emptyTitle}
        </h2>
        <p className="mx-auto mt-2 max-w-sm targ-body text-[var(--color-text-secondary)]">
          {emptyBody}
        </p>
      </Surface>
    );
  }

  return (
    <ul className="list-none space-y-2.5 p-0">
      {cases.map((currentCase, index) => {
        const statusLabel = resolveStatusLabel(currentCase);
        const context = deriveCaseListContext(
          currentCase.title,
          currentCase.userProblemStatement
        );
        const evidenceCount = currentCase.evidenceCount ?? 0;
        const confKey = currentCase.confidence?.toLowerCase() ?? "";
        const confidenceLabel = currentCase.confidence
          ? (CASE_LIST_CONFIDENCE_CHIP[confKey] ??
            DIAGNOSIS_CONFIDENCE_LABELS[
              confKey as keyof typeof DIAGNOSIS_CONFIDENCE_LABELS
            ] ??
            currentCase.confidence)
          : null;
        const showCertainty =
          currentCase.analysisState === "READY" && confidenceLabel;

        const subline =
          context ?? deriveFallbackSubline(currentCase, evidenceCount);
        const isNext = nextCaseId === currentCase.id;
        const severityHigh =
          currentCase.severity === "HIGH" ||
          currentCase.severity === "CRITICAL";

        return (
          <li
            key={`${motionKey}-${currentCase.id}`}
            className="targ-home-chip-enter"
            style={{ animationDelay: `${60 + index * 26}ms` }}
          >
            <Link
              href={`/cases/${currentCase.id}`}
              className={cn(
                "group flex items-start gap-3 rounded-[20px] border px-4 py-3.5 transition-[border-color,background-color,transform] duration-[var(--motion-base)]",
                "border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)]",
                "hover:border-[rgba(255,255,255,0.1)] hover:bg-[rgba(255,255,255,0.035)]",
                "active:bg-[rgba(255,255,255,0.05)]",
                isNext &&
                  "border-[rgba(95,168,166,0.18)] bg-[rgba(95,168,166,0.06)] hover:bg-[rgba(95,168,166,0.075)]"
              )}
            >
              <div
                className={cn(
                  "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                  rowAccentClass(currentCase.analysisState)
                )}
                aria-hidden
              />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {isNext ? (
                    <Chip className={nextUpChipClass()}>
                      Next up
                    </Chip>
                  ) : null}
                  {severityHigh ? (
                    <Chip className={severityChipClass(currentCase.severity)}>
                      {formatSeverityLabel(currentCase.severity ?? "HIGH")}
                    </Chip>
                  ) : null}
                </div>

                <h2 className="mt-1.5 text-[14px] font-semibold leading-[19px] tracking-[-0.02em] text-[var(--color-text-primary)] sm:text-[15px] sm:leading-[20px]">
                  <span className="line-clamp-2 sm:line-clamp-1">
                    {currentCase.title}
                  </span>
                </h2>

                {subline ? (
                  <p className="mt-1 line-clamp-2 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                    {subline}
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Chip className={statusChipClass(currentCase)}>
                    {statusLabel}
                  </Chip>

                  {showCertainty ? (
                    <Chip
                      className={confidenceChipClass()}
                      title="Certainty of the latest reading"
                    >
                      {confidenceLabel}
                    </Chip>
                  ) : null}

                  <Chip
                    className={subtleMetaChipClass()}
                    aria-label={`${evidenceCount} evidence items`}
                  >
                    {formatEvidenceLabel(evidenceCount)}
                  </Chip>

                  <Chip
                    className={subtleMetaChipClass()}
                    title={formatRelativeDate(currentCase.updatedAt)}
                  >
                    {formatRelativeDate(currentCase.updatedAt)}
                  </Chip>

                  {currentCase.repoFullName ? (
                    <Chip
                      className={cn(subtleMetaChipClass(), "inline-flex items-center gap-1")}
                      title={`Scoped to ${currentCase.repoFullName}. Handoff packets emit clickable GitHub links.`}
                    >
                      <Link2 className="h-2.5 w-2.5" aria-hidden />
                      <span className="truncate max-w-[12rem]">
                        {currentCase.repoFullName}
                      </span>
                    </Chip>
                  ) : null}
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
