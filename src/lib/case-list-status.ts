/**
 * Single source for case status labels on lists, filters, and case headers.
 * Wording favors next-step clarity and Targ’s “read” vocabulary over raw system states.
 */

export type CaseStatusFields = {
  workflowState: string;
  analysisState: string;
  draftState?: string;
};

/** Lower = address sooner in triage. Used for list ordering, not shown in UI. */
export function caseInvestigationTriageRank(
  source: CaseStatusFields & { evidenceCount?: number }
): number {
  if (source.analysisState === "NEEDS_INPUT") {
    return 0;
  }
  if (source.analysisState === "FAILED") {
    return 1;
  }
  if (source.draftState === "READY") {
    return 2;
  }
  if (source.analysisState === "ANALYZING") {
    return 3;
  }
  if (
    source.analysisState === "NOT_STARTED" &&
    (source.evidenceCount ?? 0) > 0
  ) {
    return 4;
  }
  if (source.analysisState === "READY") {
    return 5;
  }
  if (source.workflowState === "RESOLVED") {
    return 7;
  }
  if (source.analysisState === "NOT_STARTED") {
    return 6;
  }
  return 6;
}

export type CaseListTriageSortable = CaseStatusFields & {
  updatedAt: Date | string;
  evidenceCount?: number;
};

export function sortCasesByInvestigationTriage<T extends CaseListTriageSortable>(
  cases: T[]
): T[] {
  return [...cases].sort((a, b) => {
    const ra = caseInvestigationTriageRank(a);
    const rb = caseInvestigationTriageRank(b);
    if (ra !== rb) {
      return ra - rb;
    }
    const ta = new Date(a.updatedAt).getTime();
    const tb = new Date(b.updatedAt).getTime();
    return tb - ta;
  });
}

export function getCaseListStatusLabel(source: CaseStatusFields): string {
  if (source.analysisState === "NEEDS_INPUT") {
    return "Needs you";
  }

  if (source.analysisState === "ANALYZING") {
    return "Reading";
  }

  if (source.analysisState === "FAILED") {
    return "Needs re-run";
  }

  if (source.draftState === "READY") {
    return "Draft ready";
  }

  if (source.analysisState === "READY") {
    return "Ready";
  }

  if (source.workflowState === "RESOLVED") {
    return "Resolved";
  }

  return "Not started";
}

export const CASE_LIST_STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "needs_you", label: "Needs you" },
  { id: "running", label: "Pending" },
  { id: "diagnosed", label: "Ready" },
] as const;

export type CaseListStatusFilterId =
  (typeof CASE_LIST_STATUS_FILTERS)[number]["id"];

export function matchesCaseListStatusFilter(
  source: CaseStatusFields,
  filter: CaseListStatusFilterId
): boolean {
  if (filter === "all") {
    return true;
  }

  if (filter === "needs_you") {
    return source.analysisState === "NEEDS_INPUT";
  }

  if (filter === "running") {
    return (
      source.analysisState === "ANALYZING" ||
      source.analysisState === "FAILED" ||
      source.analysisState === "NOT_STARTED"
    );
  }

  if (filter === "diagnosed") {
    return source.analysisState === "READY";
  }

  return true;
}

/** List chip labels for diagnosis confidence (short; tone comes from chip style). */
export const CASE_LIST_CONFIDENCE_CHIP: Record<string, string> = {
  likely: "Strong",
  plausible: "Mixed",
  unclear: "Tentative",
};

/** Confidence filter dropdown copy (values stay likely | plausible | unclear). */
export const CASE_LIST_CONFIDENCE_FILTER_LABEL: Record<string, string> = {
  all: "Any",
  likely: "Strong",
  plausible: "Mixed",
  unclear: "Tentative",
};

export function getCaseListNextUpHint(source: CaseStatusFields): string {
  if (source.analysisState === "NEEDS_INPUT") {
    return "Reply here first to unblock the queue.";
  }

  if (source.analysisState === "FAILED") {
    return "This one needs a fresh run or sharper evidence.";
  }

  if (source.draftState === "READY") {
    return "Review the draft before picking up a colder case.";
  }

  if (source.analysisState === "NOT_STARTED") {
    return "Best next candidate for a first diagnosis.";
  }

  return "Highest-priority case in your queue right now.";
}
