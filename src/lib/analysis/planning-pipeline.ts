import type { CompactCaseMemoryForVerifier } from "@/lib/analysis/draft-writer";
import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";
import type { CaseProblemLensValue } from "@/lib/planning/intake-preferences";
import type {
  ArtifactDependency,
  BreakdownDocument,
  EvidenceAnchor,
  ProblemClassification,
  RankedHypothesis,
  UnknownItem,
  WorkBundleKind,
  WorkBundlePayload,
  WorkBundleRationale,
  WorkBundleTaskGroup,
  WorkBundleUrgency,
} from "@/lib/planning/bundle-types";

const SCHEMA_VERSION = 2 as const;

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function clampText(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > max * 0.45 ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()}…`;
}

function detectPrimaryModeFromHaystack(haystack: string): string {
  if (/\b(ui|ux|screen|button|layout|copy|text|label|tooltip)\b/.test(haystack)) {
    return "experience";
  }
  if (/\b(performance|slow|latency|timeout|memory|cpu)\b/.test(haystack)) {
    return "performance";
  }
  if (/\b(flake|retry|crash|503|500|reliability|incident)\b/.test(haystack)) {
    return "reliability";
  }
  if (/\b(workflow|state|handoff|status|permission)\b/.test(haystack)) {
    return "workflow_state";
  }
  if (/\b(rule|policy|entitlement|should|calculation|price)\b/.test(haystack)) {
    return "product_logic";
  }
  if (/\b(concept|doctrine|expectation|misunderstand|term)\b/.test(haystack)) {
    return "concept_doctrine";
  }
  if (/\b(debt|refactor|architecture|coupling|monolith)\b/.test(haystack)) {
    return "systems_structure";
  }
  return "functional_defect";
}

function secondaryModesForMixed(haystack: string, primary: string): string[] {
  const pairs: Array<[string, RegExp]> = [
    ["performance", /\b(performance|slow|latency|timeout|memory|cpu)\b/],
    ["reliability", /\b(flake|retry|crash|503|500|reliability|incident)\b/],
    ["experience", /\b(ui|ux|screen|button|layout|copy|text|label)\b/],
    ["product_logic", /\b(rule|policy|entitlement|price|calculation)\b/],
    ["workflow_state", /\b(workflow|state|handoff|status|permission)\b/],
    ["systems_structure", /\b(debt|refactor|architecture|coupling|monolith)\b/],
  ];
  const out: string[] = [];
  for (const [mode, re] of pairs) {
    if (mode !== primary && re.test(haystack)) {
      out.push(mode);
    }
  }
  return out.slice(0, 2);
}

function experienceFacetFromHaystack(
  haystack: string
): "interaction" | "copy" | "mixed" {
  const copyish = /\b(copy|text|label|string|message|error text)\b/.test(
    haystack
  );
  const uiish = /\b(ui|ux|screen|button|layout)\b/.test(haystack);
  if (copyish && uiish) {
    return "mixed";
  }
  if (copyish) {
    return "copy";
  }
  return "interaction";
}

/**
 * Phase 2 — classification. Auto from text + optional user lens override on the case.
 */
export function classifyProblemFromDiagnosis(
  diagnosis: DiagnosisSnapshotViewModel,
  caseMemory: CompactCaseMemoryForVerifier
): ProblemClassification {
  const haystack =
    `${diagnosis.affectedArea} ${diagnosis.probableRootCause} ${caseMemory.userProblemStatement}`.toLowerCase();

  const autoPrimary = detectPrimaryModeFromHaystack(haystack);
  const lens = (caseMemory.problemLens ?? null) as CaseProblemLensValue | null;

  let primaryMode = autoPrimary;
  let secondaryModes: string[] = [];

  if (lens === "code") {
    primaryMode = "functional_defect";
  } else if (lens === "ux_ui") {
    primaryMode = "experience";
  } else if (lens === "product") {
    primaryMode = "product_logic";
  } else if (lens === "doctrine") {
    primaryMode = "concept_doctrine";
  } else if (lens === "mixed") {
    primaryMode = autoPrimary;
    secondaryModes = secondaryModesForMixed(haystack, primaryMode);
  }

  const confidence: ProblemClassification["confidence"] =
    diagnosis.confidence === "likely"
      ? "high"
      : diagnosis.confidence === "plausible"
        ? "medium"
        : "low";

  const experienceFacet =
    primaryMode === "experience" ? experienceFacetFromHaystack(haystack) : undefined;

  const baseRationale = `Diagnosis next action: ${diagnosis.nextActionMode}; text/evidence cues.`;
  const rationale = lens
    ? lens === "mixed"
      ? `Mixed lens: primary "${primaryMode}" from signals; secondaries: ${secondaryModes.join(", ") || "none"}. ${baseRationale}`
      : `Lens override "${lens}" → "${primaryMode}". ${baseRationale}`
    : baseRationale;

  return {
    primaryMode,
    secondaryModes: secondaryModes.length > 0 ? secondaryModes : undefined,
    experienceFacet,
    confidence,
    rationale,
  };
}

/**
 * Phase 3 — decomposition. Today: structured projection from diagnosis + anchors.
 * Later: LLM fills modeExtensions and enriches sharedSpine without replacing evidence anchors.
 */
export function decomposeFromDiagnosis(params: {
  diagnosis: DiagnosisSnapshotViewModel;
  classification: ProblemClassification;
  caseMemory: CompactCaseMemoryForVerifier;
}): BreakdownDocument {
  const { diagnosis, classification, caseMemory } = params;

  const evidenceAnchors: EvidenceAnchor[] = [];
  diagnosis.claimReferences.forEach((ref, index) => {
    const evidenceId =
      ref.evidenceId ?? caseMemory.evidence[0]?.id ?? undefined;
    if (!evidenceId) {
      return;
    }
    const role: EvidenceAnchor["role"] =
      ref.relation === "supports"
        ? "supports"
        : ref.relation === "weakens"
          ? "contradicts"
          : "context";
    evidenceAnchors.push({
      id: `a-${index}`,
      evidenceId,
      role,
      note: ref.claimText.slice(0, 120),
    });
  });

  const rankedHypotheses: RankedHypothesis[] = diagnosis.hypotheses.map(
    (hypothesis, index) => ({
      id: `h-${index}`,
      text: hypothesis.title,
      rank: index + 1,
      confidence: hypothesis.confidence,
      linkedEvidenceAnchorIds:
        evidenceAnchors.length > 0
          ? evidenceAnchors.slice(0, 2).map((anchor) => anchor.id)
          : [],
    })
  );

  const unknowns: UnknownItem[] = diagnosis.missingEvidence.map((text, index) => ({
    id: `u-${index}`,
    text,
    blocking: diagnosis.confidence === "unclear" && index === 0,
  }));

  const artifactDependencies: ArtifactDependency[] =
    evidenceAnchors.length > 0
      ? rankedHypotheses.flatMap((hypothesis) =>
          evidenceAnchors.slice(0, 1).map((anchor, dependencyIndex) => ({
            id: `dep-${hypothesis.id}-${dependencyIndex}`,
            fromKind: "hypothesis" as const,
            fromRef: hypothesis.id,
            toKind: "evidence" as const,
            toRef: anchor.id,
            relation: "requires" as const,
          }))
        )
      : [];

  const sharedSpine: Record<string, unknown> = {
    observedSignal: diagnosis.summary,
    expectedVsActual: diagnosis.probableRootCause,
    boundaries: {
      affectedArea: diagnosis.affectedArea,
      caseTitle: caseMemory.title,
    },
    evidenceIndex: {
      readyCount: caseMemory.evidenceCounts.ready,
      totalCount: caseMemory.evidenceCounts.total,
    },
    intakePreferences: {
      solveMode: caseMemory.solveMode ?? null,
      problemLens: caseMemory.problemLens ?? null,
    },
    decisionStub: {
      nextActionMode: diagnosis.nextActionMode,
      nextActionText: diagnosis.nextActionText,
    },
  };

  const modeExtensions: Record<string, unknown> = {
    [classification.primaryMode]: {
      notes: `Auto decomposition for mode "${classification.primaryMode}".`,
      contradictions: diagnosis.contradictions,
    },
  };

  return {
    schemaVersion: 1,
    problemClassification: classification,
    sharedSpine,
    modeExtensions,
    rankedHypotheses,
    unknowns,
    artifactDependencies,
    evidenceAnchors,
  };
}

function bundleMetaFromDiagnosis(params: {
  diagnosis: DiagnosisSnapshotViewModel;
  caseMemory: CompactCaseMemoryForVerifier;
}): {
  title: string;
  kind: WorkBundleKind;
  urgency: WorkBundleUrgency;
  rationale: WorkBundleRationale;
} {
  const { diagnosis, caseMemory } = params;
  const risksOrUnknowns = uniqueStrings([
    ...diagnosis.contradictions,
    ...diagnosis.missingEvidence,
  ]).slice(0, 4);

  const solve = caseMemory.solveMode ?? null;
  const diagnosisAllowsFix =
    diagnosis.confidence === "likely" && diagnosis.nextActionMode === "fix";

  const headline =
    diagnosis.summary.slice(0, 140) + (diagnosis.summary.length > 140 ? "…" : "");
  const area = diagnosis.affectedArea;

  /** Strategic intent always biases investigation-first bundles. */
  const kind: WorkBundleKind =
    solve === "strategic_improvement" || !diagnosisAllowsFix
      ? "investigation_ready"
      : "fix_ready";

  let title: string;
  if (solve === "strategic_improvement") {
    title = `Strategic improvement · ${area}`;
  } else if (kind === "fix_ready" && solve === "quick_patch") {
    title = `Quick patch · ${area}`;
  } else if (kind === "fix_ready") {
    title = `Stabilize ${area}`;
  } else {
    title = `Tighten evidence around ${area}`;
  }

  let whyNow: string;
  if (solve === "strategic_improvement") {
    whyNow =
      "Strategic mode: map tradeoffs and validate impact before locking implementation scope.";
  } else if (kind === "fix_ready" && solve === "quick_patch") {
    whyNow =
      "Quick patch: keep changes minimal and reversible until follow-up hardening.";
  } else if (kind === "fix_ready") {
    whyNow =
      "The reading supports a focused change; still close blocking gaps before shipping.";
  } else if (diagnosis.confidence === "plausible") {
    whyNow =
      "The reading is useful but needs sharper grounding before implementation.";
  } else {
    whyNow = "The next move should reduce uncertainty before execution.";
  }

  const alternateApproach =
    kind === "fix_ready" && solve === "proper_fix"
      ? "If you need immediate relief, ship the smallest safe guard first; return for full hardening after gaps are closed."
      : undefined;

  const urgency: WorkBundleUrgency =
    kind === "fix_ready"
      ? risksOrUnknowns.length > 0
        ? "high"
        : "medium"
      : diagnosis.nextActionMode === "request_input"
        ? "medium"
        : diagnosis.confidence === "plausible"
          ? "medium"
          : "low";

  return {
    title,
    kind,
    urgency,
    rationale: {
      headline,
      whyNow,
      primaryRisk:
        risksOrUnknowns[0] ??
        (diagnosis.contradictions.length > 0
          ? "Contradictions may widen if the fix is too broad."
          : undefined),
      alternateApproach,
    },
  };
}

function classificationModes(breakdown: BreakdownDocument) {
  const primary = breakdown.problemClassification?.primaryMode ?? null;
  const secondary = breakdown.problemClassification?.secondaryModes ?? [];
  return uniqueStrings([primary ?? "", ...secondary]);
}

function buildTaskGroupsFromBreakdown(params: {
  diagnosis: DiagnosisSnapshotViewModel;
  breakdown: BreakdownDocument;
  caseMemory: CompactCaseMemoryForVerifier;
}): WorkBundleTaskGroup[] {
  const { diagnosis, breakdown, caseMemory } = params;
  const groups: WorkBundleTaskGroup[] = [];

  const anchorIds = breakdown.evidenceAnchors.map((anchor) => anchor.id);
  const hypothesisIds = breakdown.rankedHypotheses.map((hypothesis) => hypothesis.id);
  const unknownIds = breakdown.unknowns.map((unknown) => unknown.id);
  const modes = classificationModes(breakdown);
  const primaryMode = breakdown.problemClassification?.primaryMode ?? null;
  const needsProductTrack = modes.some((mode) =>
    ["experience", "product_logic", "workflow_state", "concept_doctrine"].includes(mode)
  );
  const needsDesignTrack =
    modes.includes("experience") ||
    breakdown.problemClassification?.experienceFacet !== undefined;

  const solve = caseMemory.solveMode ?? null;
  const diagnosisAllowsFix =
    diagnosis.nextActionMode === "fix" && diagnosis.confidence === "likely";
  const fixReady =
    diagnosisAllowsFix && solve !== "strategic_improvement";
  const investigationReady =
    diagnosis.nextActionMode === "verify" ||
    diagnosis.confidence !== "likely" ||
    diagnosis.nextActionMode === "request_input";

  const blockingUnknownTaskIds = breakdown.unknowns
    .filter((unknown) => unknown.blocking)
    .map((unknown) => `task-${unknown.id}`);

  let sectionOrder = 1;

  groups.push({
    id: "group-trace",
    order: sectionOrder,
    title: "Research read",
    objective: "Confirm the current diagnosis against the cited evidence before acting.",
    rationale: "Sanity-check the diagnosis against what is actually in the case.",
    mode: breakdown.problemClassification?.primaryMode,
    dependsOnGroupIds: [],
    tasks: diagnosis.trace.slice(0, 4).map((entry, index) => ({
      id: `task-trace-${index}`,
      order: index + 1,
      title: `Check claim ${index + 1}`,
      type: "verify" as const,
      rationale: "Tie this claim to evidence or mark it weak.",
      objective: entry.claim.slice(0, 200),
      acceptanceCriteria: [
        "Evidence supports or weakens the claim; note gaps.",
      ],
      evidenceLinkIds: anchorIds.slice(0, 3),
      hypothesisIds: hypothesisIds.slice(0, 1),
      dependsOnTaskIds: index > 0 ? [`task-trace-${index - 1}`] : undefined,
    })),
  });
  sectionOrder += 1;

  if (breakdown.unknowns.length > 0) {
    groups.push({
      id: "group-unknowns",
      order: sectionOrder,
      title: "Close evidence gaps",
      objective: "Gather missing evidence or explicitly accept residual risk.",
      rationale: "Unknowns listed in the reading are handled or consciously deferred.",
      dependsOnGroupIds: ["group-trace"],
      tasks: breakdown.unknowns.slice(0, 2).map((unknown, index) => ({
        id: `task-${unknown.id}`,
        order: index + 1,
        title: `Resolve: ${unknown.text.slice(0, 72)}${unknown.text.length > 72 ? "…" : ""}`,
        type: unknown.blocking ? ("research" as const) : ("verify" as const),
        rationale: unknown.blocking
          ? "Blocking gap—resolve before execution-heavy work."
          : "Reduce uncertainty for a cleaner next decision.",
        acceptanceCriteria: [
          "Obtain artifact or explicit stakeholder confirmation.",
          "Update case evidence if new material is added.",
        ],
        evidenceLinkIds: [],
        unknownIds: [unknown.id],
      })),
    });
    sectionOrder += 1;
  }

  const productTrackDependsOn =
    breakdown.unknowns.length > 0 ? ["group-unknowns"] : ["group-trace"];

  if (needsProductTrack) {
    const isWorkflowHeavy = modes.some((mode) =>
      ["workflow_state", "product_logic", "concept_doctrine"].includes(mode)
    );

    groups.push({
      id: "group-product",
      order: sectionOrder,
      title: "Product decision",
      objective: "Make the expected behavior explicit before implementation branches.",
      rationale:
        "Turns the diagnosis into a concrete product decision, not just a technical hunch.",
      mode: primaryMode ?? undefined,
      dependsOnGroupIds: productTrackDependsOn,
      tasks: [
        {
          id: "task-product-outcome",
          order: 1,
          title: isWorkflowHeavy
            ? "Define the expected behavior and failing decision boundary"
            : "State the user-visible outcome this work must restore",
          type: "communicate" as const,
          rationale:
            "Align the case around the job to be fixed before changes or polish begin.",
          objective: clampText(
            diagnosis.problemBrief?.restatedProblem ??
              caseMemory.userProblemStatement ??
              diagnosis.summary,
            180
          ),
          acceptanceCriteria: [
            "Expected behavior is written in plain language.",
            "The team can say what outcome means fixed for the user or workflow.",
          ],
          evidenceLinkIds: anchorIds.slice(0, 2),
          hypothesisIds: hypothesisIds.slice(0, 1),
        },
        {
          id: "task-product-scope",
          order: 2,
          title: isWorkflowHeavy
            ? "Map the failing rule, state, or handoff"
            : "Name the scope boundary this fix should not cross",
          type: "research" as const,
          rationale:
            "Keeps the next step from solving the wrong problem or expanding scope silently.",
          objective: diagnosis.nextActionText,
          acceptanceCriteria: [
            "Broken rule, state, or boundary is named.",
            "The next owner knows what stays in scope and what does not.",
          ],
          evidenceLinkIds: anchorIds.slice(0, 2),
          unknownIds: unknownIds.slice(0, 1),
          hypothesisIds: hypothesisIds.slice(0, 1),
        },
      ],
    });
    sectionOrder += 1;
  }

  const designTrackDependsOn = needsProductTrack
    ? ["group-product"]
    : productTrackDependsOn;

  if (needsDesignTrack) {
    const facet = breakdown.problemClassification?.experienceFacet ?? "interaction";
    const designTasks: WorkBundleTaskGroup["tasks"] = [
      {
        id: "task-design-state",
        order: 1,
        title:
          facet === "copy"
            ? "Rewrite the user-facing message around the failure"
            : "Map the broken state and the intended state after the fix",
        type: "design" as const,
        rationale:
          "Translate the diagnosis into a visible product experience, not only a backend change.",
        objective: clampText(diagnosis.summary, 180),
        acceptanceCriteria: [
          facet === "copy"
            ? "Replacement message is clear, specific, and matches the read."
            : "Broken, intended, and edge states are named clearly.",
          "The design change is small enough to verify after the next pass.",
        ],
        evidenceLinkIds: anchorIds.slice(0, 2),
        hypothesisIds: hypothesisIds.slice(0, 1),
      },
    ];

    if (facet !== "copy") {
      designTasks.push({
        id: "task-design-edges",
        order: 2,
        title: "Check empty, loading, and recovery states around the failure",
        type: "design" as const,
        rationale:
          "Prevents a narrow fix from leaving the surrounding experience inconsistent.",
        acceptanceCriteria: [
          "Adjacent user states are reviewed and intentionally handled.",
        ],
        evidenceLinkIds: anchorIds.slice(0, 1),
        hypothesisIds: hypothesisIds.slice(0, 1),
      });
    }

    groups.push({
      id: "group-design",
      order: sectionOrder,
      title: "Design move",
      objective: "Carry the analysis through the visible product experience.",
      rationale:
        "The issue is at least partially user-facing, so the solution needs an explicit design read.",
      mode: "experience",
      dependsOnGroupIds: designTrackDependsOn,
      tasks: designTasks,
    });
    sectionOrder += 1;
  }

  const primaryTaskType = fixReady ? "implement" : investigationReady ? "research" : "verify";
  const primaryAcceptance = fixReady
    ? [
        "Change scoped to affected area; checks or tests noted.",
        "Rollback path identified if deploy-related.",
        "Definition of done: observable signal matches intent (test, metric, or explicit sign-off).",
      ]
    : [
        "Document what was verified and what remains unknown.",
        "Link any new evidence to the case.",
        "Definition of done: next decision is explicit (fix, more research, or escalate).",
      ];

  groups.push({
    id: "group-next",
    order: sectionOrder,
    title: fixReady ? "Engineering path" : "Validation path",
    objective: diagnosis.nextActionText,
    rationale: fixReady
      ? "Smallest change that addresses the strongest supported cause."
      : "Learn enough to either fix with confidence or narrow the problem.",
    dependsOnGroupIds:
      needsDesignTrack
        ? ["group-design"]
        : needsProductTrack
          ? ["group-product"]
          : breakdown.unknowns.length > 0
            ? ["group-unknowns"]
            : ["group-trace"],
    tasks: [
      {
        id: "task-primary-next",
        order: 1,
        title: fixReady
          ? "Apply targeted change from the reading"
          : "Run scoped investigation per the reading",
        type: primaryTaskType,
        rationale: diagnosis.nextActionText.slice(0, 160),
        objective: diagnosis.nextActionText,
        acceptanceCriteria: primaryAcceptance,
        evidenceLinkIds: anchorIds,
        hypothesisIds: hypothesisIds.slice(0, 2),
        unknownIds: unknownIds.slice(0, 2),
        dependsOnTaskIds:
          fixReady && blockingUnknownTaskIds.length > 0
            ? blockingUnknownTaskIds
            : undefined,
      },
    ],
  });
  sectionOrder += 1;

  const needsCommunicationTrack =
    solve === "strategic_improvement" ||
    diagnosis.contradictions.length > 0 ||
    diagnosis.confidence !== "likely" ||
    breakdown.unknowns.length > 0;

  if (needsCommunicationTrack) {
    groups.push({
      id: "group-communication",
      order: sectionOrder,
      title: "Decision handoff",
      objective: "Preserve the current call so the next operator can continue without re-reading the whole case.",
      rationale:
        "Complex cases fail when the decision, risk, and next proof step are not carried forward cleanly.",
      dependsOnGroupIds: ["group-next"],
      tasks: [
        {
          id: "task-communicate-call",
          order: 1,
          title: fixReady
            ? "Record the current call, scope, and remaining risks"
            : "Record what is known, unknown, and next to prove",
          type: "communicate" as const,
          rationale:
            "Makes the analysis portable to the next teammate or future pass.",
          objective: clampText(diagnosis.summary, 180),
          acceptanceCriteria: [
            "Current call is written in a few lines.",
            "Open risks or unknowns are explicit.",
          ],
          evidenceLinkIds: anchorIds.slice(0, 2),
          unknownIds: unknownIds.slice(0, 2),
          hypothesisIds: hypothesisIds.slice(0, 1),
        },
        {
          id: "task-communicate-next",
          order: 2,
          title:
            solve === "strategic_improvement"
              ? "Prepare the next decision checkpoint before broader rollout"
              : "Prepare the next handoff or escalation note",
          type: "communicate" as const,
          rationale:
            "Reduces thrash when more evidence, approval, or a broader change is still needed.",
          acceptanceCriteria: [
            "Next owner knows what to do next and what not to assume.",
          ],
          evidenceLinkIds: anchorIds.slice(0, 1),
          unknownIds: unknownIds.slice(0, 1),
        },
      ],
    });
  }

  return groups;
}

function dependencyOverviewFromGroups(groups: WorkBundleTaskGroup[]): string {
  const sorted = [...groups].sort((a, b) => a.order - b.order);
  const labels = sorted.map((g) => g.title);
  return `${labels.join(" → ")}.`;
}

/**
 * Phase 4 — work bundle from decomposition (not generic flat suggestions).
 */
export function buildWorkBundleFromBreakdown(params: {
  diagnosis: DiagnosisSnapshotViewModel;
  breakdown: BreakdownDocument;
  breakdownIdPlaceholder: string;
  caseMemory: CompactCaseMemoryForVerifier;
}): WorkBundlePayload {
  const { diagnosis, breakdown, caseMemory } = params;

  const taskGroups = buildTaskGroupsFromBreakdown({
    diagnosis,
    breakdown,
    caseMemory,
  });
  const meta = bundleMetaFromDiagnosis({ diagnosis, caseMemory });

  return {
    schemaVersion: SCHEMA_VERSION,
    title: meta.title,
    kind: meta.kind,
    urgency: meta.urgency,
    rationale: meta.rationale,
    dependencyOverview: dependencyOverviewFromGroups(taskGroups),
    lineage: {
      diagnosisSnapshotId: diagnosis.id,
      breakdownId: params.breakdownIdPlaceholder,
      inheritedDiagnosisConfidence: diagnosis.confidence,
      unknownsCarriedForward: breakdown.unknowns,
      confidenceSummary: `Diagnosis confidence: ${diagnosis.confidence}. ${diagnosis.summary.slice(0, 160)}${diagnosis.summary.length > 160 ? "…" : ""}`,
    },
    taskGroups,
  };
}
