import type { CaseProblemLens } from "@prisma/client";

import { Chip } from "@/components/ui/primitives";
import { DIAGNOSIS_CONFIDENCE_LABELS } from "@/lib/analysis/constants";
import type {
  ActionDraftViewModel,
  BreakdownViewModel,
  DiagnosisSnapshotViewModel,
  WorkBundleViewModel,
} from "@/lib/analysis/view-model";
import { problemLensDisplayLabel } from "@/lib/planning/intake-preferences";

type CaseProblemBriefProps = {
  caseTitle: string;
  userProblemStatement: string;
  caseProblemLens: CaseProblemLens | null;
  diagnosis: DiagnosisSnapshotViewModel;
  draft: ActionDraftViewModel | null;
  breakdown: BreakdownViewModel | null;
  workBundle: WorkBundleViewModel | null;
};

const PRIMARY_MODE_LABELS: Record<string, string> = {
  experience: "Experience",
  performance: "Performance",
  reliability: "Reliability",
  workflow_state: "Workflow",
  product_logic: "Product logic",
  concept_doctrine: "Doctrine",
  systems_structure: "System structure",
  functional_defect: "Functional defect",
};

const DISCIPLINE_LABELS: Record<string, string> = {
  research: "Research",
  design: "Design",
  implement: "Engineering",
  verify: "Validation",
  communicate: "Communication",
};

function normalizeDedup(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function clampAtWord(s: string, maxChars: number) {
  const t = s.trim();
  if (t.length <= maxChars) {
    return t;
  }
  const slice = t.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > maxChars * 0.55 ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()}…`;
}

function firstReportedLine(statement: string, maxChars: number): string {
  const first = statement.trim().split(/\n/)[0]?.trim() ?? "";
  return clampAtWord(first, maxChars);
}

function framedProblemBlock(params: {
  caseTitle: string;
  userProblemStatement: string;
  diagnosis: DiagnosisSnapshotViewModel;
}): string {
  const brief = params.diagnosis.problemBrief;
  if (brief?.restatedProblem?.trim()) {
    return clampAtWord(brief.restatedProblem.trim(), 520);
  }

  const titleNorm = normalizeDedup(params.caseTitle);
  const reported = firstReportedLine(params.userProblemStatement, 220);
  const reportedNorm = normalizeDedup(reported);
  const summary = params.diagnosis.summary.trim();

  if (reported.length > 0 && reportedNorm !== titleNorm) {
    return clampAtWord(`${reported} ${summary}`, 520);
  }

  return clampAtWord(summary, 520);
}

function reportedProblemLine(params: {
  caseTitle: string;
  userProblemStatement: string;
}) {
  const titleNorm = normalizeDedup(params.caseTitle);
  const reported = firstReportedLine(params.userProblemStatement, 220);

  if (!reported || normalizeDedup(reported) === titleNorm) {
    return null;
  }

  return reported;
}

function currentReadLine(diagnosis: DiagnosisSnapshotViewModel) {
  const brief = diagnosis.problemBrief?.restatedProblem?.trim();
  if (brief) {
    return clampAtWord(brief, 240);
  }
  return clampAtWord(diagnosis.summary.trim(), 240);
}

function workingTheoryLine(diagnosis: DiagnosisSnapshotViewModel): string {
  const root = diagnosis.probableRootCause.trim();
  if (root.length > 0) {
    return clampAtWord(root, 320);
  }
  return clampAtWord(diagnosis.summary.trim(), 320);
}

function scopeTags(diagnosis: DiagnosisSnapshotViewModel): string[] {
  const area = diagnosis.affectedArea.trim().toLowerCase();
  const fromBrief = diagnosis.problemBrief?.scopeIn ?? [];
  const out: string[] = [];
  for (const item of fromBrief) {
    const t = item.trim();
    if (!t || t.toLowerCase() === area || out.includes(t)) {
      continue;
    }
    out.push(clampAtWord(t, 40));
    if (out.length >= 2) {
      break;
    }
  }
  return out;
}

function analysisModeLabel(breakdown: BreakdownViewModel | null) {
  const primaryMode = breakdown?.problemClassification?.primaryMode;
  if (!primaryMode) {
    return "General";
  }
  return PRIMARY_MODE_LABELS[primaryMode] ?? clampAtWord(primaryMode, 32);
}

function secondaryModesLabel(breakdown: BreakdownViewModel | null) {
  const secondary = breakdown?.problemClassification?.secondaryModes ?? [];
  if (secondary.length === 0) {
    return null;
  }

  return secondary
    .map((mode) => PRIMARY_MODE_LABELS[mode] ?? clampAtWord(mode, 20))
    .join(" · ");
}

function perspectivesInPlay(
  breakdown: BreakdownViewModel | null,
  workBundle: WorkBundleViewModel | null
) {
  const out: string[] = [];
  const primaryMode = breakdown?.problemClassification?.primaryMode ?? null;

  if (primaryMode === "experience") {
    out.push("Design");
  }

  if (
    primaryMode === "product_logic" ||
    primaryMode === "workflow_state" ||
    primaryMode === "concept_doctrine"
  ) {
    out.push("Product");
  }

  if (
    primaryMode === "functional_defect" ||
    primaryMode === "reliability" ||
    primaryMode === "performance" ||
    primaryMode === "systems_structure"
  ) {
    out.push("Engineering");
  }

  for (const group of workBundle?.payload.taskGroups ?? []) {
    for (const task of group.tasks) {
      const label = DISCIPLINE_LABELS[task.type];
      if (label && !out.includes(label)) {
        out.push(label);
      }
    }
  }

  return out.slice(0, 5);
}

function workFocusLine(
  diagnosis: DiagnosisSnapshotViewModel,
  workBundle: WorkBundleViewModel | null
) {
  if (workBundle?.payload.title?.trim()) {
    return clampAtWord(workBundle.payload.title, 180);
  }
  return clampAtWord(diagnosis.nextActionText, 180);
}

function successLine(
  diagnosis: DiagnosisSnapshotViewModel,
  workBundle: WorkBundleViewModel | null
) {
  const firstCriteria = [...(workBundle?.payload.taskGroups ?? [])]
    .sort((a, b) => a.order - b.order)
    .flatMap((group) =>
      [...group.tasks]
        .sort((a, b) => a.order - b.order)
        .flatMap((task) => task.acceptanceCriteria)
    )[0];

  if (firstCriteria) {
    return clampAtWord(firstCriteria, 180);
  }

  return clampAtWord(diagnosis.nextActionText, 180);
}

function urgencyDisplay(
  draft: ActionDraftViewModel | null,
  workBundle: WorkBundleViewModel | null
) {
  const urgency =
    draft?.urgency?.trim().toLowerCase() ?? workBundle?.payload.urgency ?? null;

  if (urgency === "high") {
    return "High";
  }
  if (urgency === "medium") {
    return "Medium";
  }
  if (urgency === "low") {
    return "Low";
  }

  return null;
}

function FrameCard({
  label,
  body,
}: {
  label: string;
  body: string;
}) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/80 bg-[rgba(255,255,255,0.02)] px-3 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {label}
      </p>
      <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
        {body}
      </p>
    </div>
  );
}

export function CaseProblemBrief({
  caseTitle,
  userProblemStatement,
  caseProblemLens,
  diagnosis,
  draft,
  breakdown,
  workBundle,
}: CaseProblemBriefProps) {
  const framed = framedProblemBlock({
    caseTitle,
    userProblemStatement,
    diagnosis,
  });
  const reported = diagnosis.problemBrief?.reportedProblem ?? reportedProblemLine({
    caseTitle,
    userProblemStatement,
  });
  const currentRead = diagnosis.problemBrief?.currentRead ?? currentReadLine(diagnosis);
  const theory = workingTheoryLine(diagnosis);
  const perspectives =
    diagnosis.problemBrief?.perspectives?.length
      ? diagnosis.problemBrief.perspectives
      : perspectivesInPlay(breakdown, workBundle);
  const urgency = urgencyDisplay(draft, workBundle);
  const areaLabel = diagnosis.affectedArea.trim()
    ? clampAtWord(diagnosis.affectedArea.trim(), 56)
    : null;
  const extraScope = scopeTags(diagnosis);
  const secondaryModes = secondaryModesLabel(breakdown);
  const workFocus =
    diagnosis.problemBrief?.workObjective ?? workFocusLine(diagnosis, workBundle);
  const success =
    diagnosis.problemBrief?.successSignal ?? successLine(diagnosis, workBundle);
  const userImpact = diagnosis.problemBrief?.userImpact ?? null;
  const researchFocus = diagnosis.problemBrief?.researchFocus ?? null;
  const primaryModeLabel = diagnosis.problemBrief?.primaryMode ?? null;
  const stakes = diagnosis.problemBrief?.stakes ?? null;

  return (
    <section
      className="scroll-mt-6 max-lg:scroll-mt-28"
      aria-labelledby="case-problem-brief-heading"
    >
      <details className="group rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/70 bg-[rgba(255,255,255,0.015)] px-3 py-3">
        <summary className="flex cursor-pointer list-none flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
          <div>
            <h2
              id="case-problem-brief-heading"
              className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]"
            >
              Case frame
            </h2>
            <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
              {currentRead}
            </p>
          </div>
          <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
            Open
          </span>
        </summary>

        <div className="mt-3 space-y-3">
          <p className="text-[13px] leading-[20px] text-[var(--color-text-primary)]">
            {framed}
          </p>

          {stakes ? (
            <p className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/70 bg-[rgba(255,255,255,0.02)] px-3 py-2.5 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
              <span className="font-medium text-[var(--color-text-primary)]">
                Why this frame matters:
              </span>{" "}
              {stakes}
            </p>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <FrameCard label="Reported signal" body={reported ?? caseTitle} />
            <FrameCard label="Targ reframed" body={currentRead} />
            <FrameCard
              label="Analysis mode"
              body={[
                primaryModeLabel ?? analysisModeLabel(breakdown),
                secondaryModes,
                breakdown?.problemClassification?.experienceFacet
                  ? `Facet: ${breakdown.problemClassification.experienceFacet}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
            <FrameCard label="Work focus" body={workFocus} />
          </div>

          {(perspectives.length > 0 || areaLabel || urgency) && (
            <div className="space-y-2">
              {perspectives.length > 0 ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                    Perspectives in play
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {perspectives.map((item) => (
                      <Chip key={item}>{item}</Chip>
                    ))}
                  </div>
                </div>
              ) : null}

              <p className="text-[11px] font-medium leading-[17px] text-[var(--color-text-muted)]">
                <span title="Problem lens from intake; Auto means inferred from evidence.">
                  {problemLensDisplayLabel(caseProblemLens)}
                </span>
                {!caseProblemLens ? (
                  <span> · inferred from current evidence</span>
                ) : null}
                {areaLabel ? (
                  <>
                    {" "}
                    · <span title="Where the issue shows up.">{areaLabel}</span>
                  </>
                ) : null}
                {extraScope.length > 0 ? <> · {extraScope.join(" · ")}</> : null}
                {urgency ? <> · Urgency {urgency}</> : null}
              </p>
            </div>
          )}

          <div className="border-t border-[var(--color-border-subtle)]/70 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
              Current thesis
            </p>
            <p className="mt-1 text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
              {theory}
            </p>
            {userImpact ? (
              <p className="mt-2 text-[11px] leading-[17px] text-[var(--color-text-secondary)]">
                <span className="font-medium text-[var(--color-text-primary)]">
                  Likely impact:
                </span>{" "}
                {userImpact}
              </p>
            ) : null}
            <p className="mt-2 text-[11px] leading-[17px] text-[var(--color-text-secondary)]">
              <span className="font-medium text-[var(--color-text-primary)]">
                Success looks like:
              </span>{" "}
              {success}
            </p>
            {researchFocus ? (
              <p className="mt-1.5 text-[11px] leading-[17px] text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text-secondary)]">
                  Confirm next:
                </span>{" "}
                {researchFocus}
              </p>
            ) : null}
            <p className="mt-1.5 text-[11px] leading-[17px] text-[var(--color-text-secondary)]">
              <span className="text-[var(--color-text-muted)]">Read strength</span>{" "}
              <span
                className={
                  diagnosis.confidence === "unclear"
                    ? "font-semibold text-[var(--color-state-warning)]"
                    : "font-semibold text-[var(--color-text-primary)]"
                }
              >
                {DIAGNOSIS_CONFIDENCE_LABELS[diagnosis.confidence]}
              </span>
            </p>
          </div>
        </div>
      </details>
    </section>
  );
}
