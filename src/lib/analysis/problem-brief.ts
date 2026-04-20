import type { DiagnosisSnapshotPayload } from "@/lib/validators";

/**
 * User-facing problem framing stored append-only on each diagnosis snapshot.
 * Distinct from the investigator/diagnosis trace: optimized for brief + scope.
 */
export type ProblemBriefDisciplineRole =
  | "research"
  | "product"
  | "design"
  | "engineering";

export type ProblemBriefDisciplineInsight = {
  role: ProblemBriefDisciplineRole;
  read: string;
  focus: string;
};

export type ProblemBriefPayload = {
  schemaVersion: 1 | 2 | 3;
  /** Plain-language restatement combining case intent and reading. */
  restatedProblem: string;
  /** What is considered in scope for this reading. */
  scopeIn: string[];
  /** Explicit non-goals to reduce overreach. */
  scopeOut: string[];
  /** Why this matters if wrong or delayed (one short line). */
  stakes?: string;
  /** First human-reported signal, when distinct from the title. */
  reportedProblem?: string;
  /** Targ's current restatement of what is actually wrong. */
  currentRead?: string;
  /** Likely user or workflow impact if the read is directionally correct. */
  userImpact?: string;
  /** Current work objective for the operator. */
  workObjective?: string;
  /** What a good outcome should look like for this pass. */
  successSignal?: string;
  /** Disciplines or lenses actively implicated by the read. */
  perspectives?: string[];
  /** Main mode label for the current read. */
  primaryMode?: string;
  /** What to confirm next before overcommitting. */
  researchFocus?: string;
  /** Multidisciplinary read distilled into the main operating lenses. */
  disciplineInsights?: ProblemBriefDisciplineInsight[];
};

export function buildProblemBriefPayload(params: {
  userProblemStatement: string;
  diagnosis: DiagnosisSnapshotPayload;
}): ProblemBriefPayload {
  const { userProblemStatement, diagnosis } = params;
  const lead = userProblemStatement.trim().split("\n")[0]?.trim() ?? "";
  const haystack = `${lead} ${diagnosis.affected_area} ${diagnosis.summary} ${diagnosis.probable_root_cause}`.toLowerCase();
  const primaryMode = detectPrimaryMode(haystack);
  const perspectives = inferPerspectives({
    primaryMode,
    diagnosis,
  });
  const userImpact = inferUserImpact({
    primaryMode,
    diagnosis,
    lead,
  });
  const currentRead = diagnosis.summary.slice(0, 420);
  const workObjective = inferWorkObjective({
    primaryMode,
    diagnosis,
  });
  const successSignal = inferSuccessSignal({
    primaryMode,
    diagnosis,
  });
  const researchFocus = inferResearchFocus({
    diagnosis,
  });
  const disciplineInsights = buildDisciplineInsights({
    primaryMode,
    diagnosis,
    currentRead,
    userImpact,
    workObjective,
    successSignal,
    researchFocus,
  });
  const restatedProblem = [
    lead.length > 0 ? `You reported: ${lead.slice(0, 360)}${lead.length > 360 ? "…" : ""}` : null,
    `Targ’s read: ${currentRead}${diagnosis.summary.length > 420 ? "…" : ""}`,
  ]
    .filter(Boolean)
    .join(" ");

  const scopeIn = uniqueNonEmpty([
    diagnosis.affected_area,
    ...diagnosis.trace.slice(0, 2).map((t) => t.evidence.slice(0, 120)),
  ]);

  const scopeOut = uniqueNonEmpty([
    diagnosis.contradictions.length > 0
      ? "Resolving contradictions beyond the cited evidence without new artifacts."
      : "",
    "Long-term roadmap or ownership changes unless evidenced.",
  ]).slice(0, 4);

  return {
    schemaVersion: 3,
    restatedProblem: restatedProblem.slice(0, 1200),
    scopeIn: scopeIn.length > 0 ? scopeIn : [diagnosis.affected_area],
    scopeOut,
    reportedProblem: lead || undefined,
    currentRead,
    userImpact,
    workObjective,
    successSignal,
    perspectives,
    primaryMode: primaryModeLabel(primaryMode),
    researchFocus,
    disciplineInsights,
    stakes:
      diagnosis.confidence === "unclear"
        ? "Missteps are likely if you execute before closing the largest gaps."
        : "Shipping the wrong fix wastes time; validate the reading against evidence first.",
  };
}

function uniqueNonEmpty(values: string[]) {
  return Array.from(
    new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))
  );
}

export function parseProblemBriefJson(value: unknown): ProblemBriefPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const o = value as Record<string, unknown>;
  if (o.schemaVersion !== 1 && o.schemaVersion !== 2 && o.schemaVersion !== 3) {
    return null;
  }
  const restatedProblem =
    typeof o.restatedProblem === "string" ? o.restatedProblem : null;
  const scopeIn = Array.isArray(o.scopeIn)
    ? o.scopeIn.filter((item): item is string => typeof item === "string")
    : null;
  const scopeOut = Array.isArray(o.scopeOut)
    ? o.scopeOut.filter((item): item is string => typeof item === "string")
    : null;
  if (!restatedProblem || !scopeIn || scopeIn.length === 0) {
    return null;
  }
  return {
    schemaVersion: o.schemaVersion === 3 ? 3 : o.schemaVersion === 2 ? 2 : 1,
    restatedProblem,
    scopeIn,
    scopeOut: scopeOut ?? [],
    stakes: typeof o.stakes === "string" ? o.stakes : undefined,
    reportedProblem:
      typeof o.reportedProblem === "string" ? o.reportedProblem : undefined,
    currentRead: typeof o.currentRead === "string" ? o.currentRead : undefined,
    userImpact: typeof o.userImpact === "string" ? o.userImpact : undefined,
    workObjective: typeof o.workObjective === "string" ? o.workObjective : undefined,
    successSignal: typeof o.successSignal === "string" ? o.successSignal : undefined,
    perspectives: Array.isArray(o.perspectives)
      ? o.perspectives.filter((item): item is string => typeof item === "string")
      : undefined,
    primaryMode: typeof o.primaryMode === "string" ? o.primaryMode : undefined,
    researchFocus: typeof o.researchFocus === "string" ? o.researchFocus : undefined,
    disciplineInsights: parseDisciplineInsights(o.disciplineInsights),
  };
}

type ProblemMode =
  | "experience"
  | "performance"
  | "reliability"
  | "workflow_state"
  | "product_logic"
  | "concept_doctrine"
  | "functional_defect";

function detectPrimaryMode(haystack: string): ProblemMode {
  if (/\b(ui|ux|screen|button|layout|copy|text|label|tooltip|empty state|loading)\b/.test(haystack)) {
    return "experience";
  }
  if (/\b(performance|slow|latency|timeout|memory|cpu)\b/.test(haystack)) {
    return "performance";
  }
  if (/\b(flake|retry|crash|503|500|incident|failure|error)\b/.test(haystack)) {
    return "reliability";
  }
  if (/\b(workflow|state|handoff|status|permission|approval)\b/.test(haystack)) {
    return "workflow_state";
  }
  if (/\b(rule|policy|entitlement|should|calculation|price|expected)\b/.test(haystack)) {
    return "product_logic";
  }
  if (/\b(concept|doctrine|expectation|misunderstand|term)\b/.test(haystack)) {
    return "concept_doctrine";
  }
  return "functional_defect";
}

function primaryModeLabel(mode: ProblemMode) {
  switch (mode) {
    case "experience":
      return "Experience";
    case "performance":
      return "Performance";
    case "reliability":
      return "Reliability";
    case "workflow_state":
      return "Workflow";
    case "product_logic":
      return "Product logic";
    case "concept_doctrine":
      return "Doctrine";
    default:
      return "Functional defect";
  }
}

function inferPerspectives(params: {
  primaryMode: ProblemMode;
  diagnosis: DiagnosisSnapshotPayload;
}) {
  const out: string[] = [];

  if (
    params.diagnosis.confidence !== "likely" ||
    params.diagnosis.contradictions.length > 0 ||
    params.diagnosis.missing_evidence.length > 0
  ) {
    out.push("Research");
  }

  if (params.primaryMode === "experience") {
    out.push("Design");
  }

  if (
    params.primaryMode === "product_logic" ||
    params.primaryMode === "workflow_state" ||
    params.primaryMode === "concept_doctrine"
  ) {
    out.push("Product");
  }

  if (
    params.primaryMode === "functional_defect" ||
    params.primaryMode === "reliability" ||
    params.primaryMode === "performance"
  ) {
    out.push("Engineering");
  }

  if (params.diagnosis.next_action_mode !== "fix") {
    out.push("Validation");
  }

  return Array.from(new Set(out)).slice(0, 5);
}

function inferUserImpact(params: {
  primaryMode: ProblemMode;
  diagnosis: DiagnosisSnapshotPayload;
  lead: string;
}) {
  switch (params.primaryMode) {
    case "experience":
      return `People are likely hitting a visible broken state, confusing message, or blocked interaction around ${params.diagnosis.affected_area}.`;
    case "workflow_state":
      return `The intended workflow is likely breaking before completion around ${params.diagnosis.affected_area}.`;
    case "product_logic":
      return "The implemented behavior may not match the product rule or expectation users rely on.";
    case "performance":
      return `People are likely feeling slowdown or timeout pressure around ${params.diagnosis.affected_area}.`;
    case "concept_doctrine":
      return "Teams may be acting on the wrong shared interpretation of what this behavior should mean.";
    case "reliability":
      return `The path through ${params.diagnosis.affected_area} likely fails inconsistently or hard enough to break confidence.`;
    default:
      return params.lead.length > 0
        ? `The case suggests the reported failure is preventing reliable completion of the intended path.`
        : `The failing path around ${params.diagnosis.affected_area} is likely blocking intended use.`;
  }
}

function inferWorkObjective(params: {
  primaryMode: ProblemMode;
  diagnosis: DiagnosisSnapshotPayload;
}) {
  switch (params.primaryMode) {
    case "experience":
      return `Restore the intended visible state around ${params.diagnosis.affected_area} without introducing adjacent UX regressions.`;
    case "workflow_state":
      return `Clarify and restore the intended workflow boundary around ${params.diagnosis.affected_area}.`;
    case "product_logic":
      return `Align the implemented behavior with the intended rule or expectation before broadening scope.`;
    case "performance":
      return `Isolate the slow boundary around ${params.diagnosis.affected_area} and prove relief with one observable check.`;
    case "concept_doctrine":
      return "Make the underlying rule or concept explicit before committing to implementation-heavy work.";
    default:
      return params.diagnosis.next_action_text;
  }
}

function inferSuccessSignal(params: {
  primaryMode: ProblemMode;
  diagnosis: DiagnosisSnapshotPayload;
}) {
  if (params.diagnosis.next_action_mode === "request_input") {
    return `The biggest missing signal is attached and the next read is no longer blocked.`;
  }

  switch (params.primaryMode) {
    case "experience":
      return `The intended state is visible and the broken or confusing state is no longer reproducible.`;
    case "workflow_state":
      return "The workflow completes cleanly and the transition or permission boundary is explicit.";
    case "product_logic":
      return "The observed behavior matches the intended rule and can be explained simply.";
    case "performance":
      return "The path completes within an acceptable bound and the signal is observable in one fresh check.";
    default:
      return "The next operator can point to one observed signal proving the case is narrowed or fixed.";
  }
}

function inferResearchFocus(params: {
  diagnosis: DiagnosisSnapshotPayload;
}) {
  if (params.diagnosis.missing_evidence[0]) {
    return params.diagnosis.missing_evidence[0];
  }

  if (params.diagnosis.contradictions[0]) {
    return params.diagnosis.contradictions[0];
  }

  return params.diagnosis.next_action_text;
}

function sentence(value: string, max = 170) {
  const text = value.trim().replace(/\s+/g, " ");

  if (!text) {
    return "";
  }

  const body =
    text.length > max
      ? `${text.slice(0, max).trimEnd()}…`
      : text;

  return /[.!?]$/.test(body) ? body : `${body}.`;
}

function parseDisciplineInsights(value: unknown): ProblemBriefDisciplineInsight[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsed = value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item)
    )
    .map((item) => ({
      role: item.role,
      read: item.read,
      focus: item.focus,
    }))
    .filter(
      (
        item
      ): item is {
        role: ProblemBriefDisciplineRole;
        read: string;
        focus: string;
      } =>
        (item.role === "research" ||
          item.role === "product" ||
          item.role === "design" ||
          item.role === "engineering") &&
        typeof item.read === "string" &&
        typeof item.focus === "string"
    );

  return parsed.length > 0 ? parsed : undefined;
}

function buildDisciplineInsights(params: {
  primaryMode: ProblemMode;
  diagnosis: DiagnosisSnapshotPayload;
  currentRead: string;
  userImpact: string;
  workObjective: string;
  successSignal: string;
  researchFocus: string;
}): ProblemBriefDisciplineInsight[] {
  const firstContradiction = params.diagnosis.contradictions[0] ?? "";
  const firstGap = params.diagnosis.missing_evidence[0] ?? "";
  const strongestSignal = params.diagnosis.trace[0]?.claim ?? params.currentRead;

  return [
    {
      role: "research",
      read: sentence(
        firstContradiction
          ? `The evidence is directionally useful, but the main tension is ${firstContradiction.toLowerCase()}`
          : `The strongest supported signal is ${strongestSignal.toLowerCase()}`
      ),
      focus: sentence(
        firstGap || params.researchFocus || "Tighten the next read with one sharper artifact or clarification"
      ),
    },
    {
      role: "product",
      read: sentence(params.userImpact),
      focus: sentence(
        params.primaryMode === "product_logic" || params.primaryMode === "workflow_state"
          ? `Lock the intended rule, state, or workflow outcome before widening scope.`
          : `Keep the work anchored to the user-visible outcome this case needs to restore.`
      ),
    },
    {
      role: "design",
      read: sentence(
        params.primaryMode === "experience"
          ? `The issue likely changes a visible state, message, or interaction and should be treated as a user-facing experience problem.`
          : `Design is still relevant here because the technical fix can leave states, copy, or recovery paths unclear if it is not carried through the UI.`
      ),
      focus: sentence(
        params.primaryMode === "experience"
          ? params.successSignal
          : `Verify the visible state, copy, and recovery path around the fix before calling the case done.`
      ),
    },
    {
      role: "engineering",
      read: sentence(
        `The most likely implementation boundary is ${params.diagnosis.affected_area}, with the current read pointing to ${params.diagnosis.probable_root_cause.toLowerCase()}`
      ),
      focus: sentence(params.workObjective),
    },
  ];
}
