import type { DiagnosisNextActionModeValue } from "@/lib/analysis/constants";
import type {
  ActionDraftViewModel,
  DiagnosisSnapshotViewModel,
} from "@/lib/analysis/view-model";
import type { CaseSolveModeValue } from "@/lib/planning/intake-preferences";

export type WorkPlanReadiness = "fix" | "investigation";

export type WorkPlanTaskType = "fix" | "investigate" | "validate" | "follow_up";

export type WorkPlanTask = {
  title: string;
  rationale: string;
  proofClaimKey: string | null;
  taskType: WorkPlanTaskType;
  doneCondition?: string;
};

export type WorkPlanGroupId = "immediate" | "core" | "validation" | "follow_up";

export type WorkPlanGroup = {
  id: WorkPlanGroupId;
  title: string;
  tasks: WorkPlanTask[];
};

export type WorkPlanModel = {
  readiness: WorkPlanReadiness;
  strapline: string;
  planDepthFraming: string;
  groups: WorkPlanGroup[];
  draftStale: boolean;
  hasDraft: boolean;
};

function planDepthFramingLine(depth: CaseSolveModeValue): string {
  if (depth === "quick_patch") {
    return "Plan depth: quick patch—small change, fast relief, explicit tradeoffs.";
  }
  if (depth === "strategic_improvement") {
    return "Plan depth: strategic—durable improvement; expect follow-on scope.";
  }
  return "Plan depth: proper fix—sound correction without unnecessary sprawl.";
}

function coreGroupTitle(depth: CaseSolveModeValue): string {
  if (depth === "quick_patch") {
    return "Core changes — minimal scope";
  }
  if (depth === "strategic_improvement") {
    return "Core changes — deeper slice";
  }
  return "Core changes";
}

function validationGroupTitle(depth: CaseSolveModeValue): string {
  if (depth === "quick_patch") {
    return "Validation — targeted check";
  }
  if (depth === "strategic_improvement") {
    return "Validation — prove the outcome";
  }
  return "Validation";
}

function followUpGroupTitle(depth: CaseSolveModeValue): string {
  if (depth === "quick_patch") {
    return "Follow-up — watch regressions";
  }
  if (depth === "strategic_improvement") {
    return "Follow-up — rollout & debt";
  }
  return "Follow-up";
}

function clampTail(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) {
    return t;
  }
  const slice = t.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > max * 0.45 ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()}…`;
}

function splitStep(step: string): { title: string; rationale: string } {
  const t = step.replace(/\s+/g, " ").trim();
  const splitLong = t.match(/^(.{10,88}?)(\.\s+)(.+)$/);
  if (splitLong) {
    return {
      title: `${splitLong[1].trim()}.`,
      rationale: splitLong[3].trim(),
    };
  }
  const emDash = t.match(/^(.{10,80}?)(\s[—–]\s)(.+)$/);
  if (emDash) {
    return {
      title: emDash[1].trim(),
      rationale: emDash[3].trim(),
    };
  }
  if (t.length <= 92) {
    return { title: t, rationale: "" };
  }
  return { title: clampTail(t, 88), rationale: t.slice(88).trim() };
}

function modeToTaskType(mode: DiagnosisNextActionModeValue): WorkPlanTaskType {
  if (mode === "verify") {
    return "validate";
  }
  if (mode === "request_input") {
    return "investigate";
  }
  return "fix";
}

function doneForMode(mode: DiagnosisNextActionModeValue): string {
  if (mode === "request_input") {
    return "Answer logged or evidence on the case.";
  }
  if (mode === "verify") {
    return "Signal captured; decision recorded.";
  }
  return "Change applied and checked at the boundary.";
}

export function workPlanTaskTypeLabel(t: WorkPlanTaskType): string {
  switch (t) {
    case "fix":
      return "Fix";
    case "investigate":
      return "Investigate";
    case "validate":
      return "Validate";
    case "follow_up":
      return "Follow-up";
    default:
      return t;
  }
}

function proofRotator(keys: string[]): () => string | null {
  let i = 0;
  return () => {
    if (keys.length === 0) {
      return null;
    }
    const k = keys[i % keys.length];
    i += 1;
    return k;
  };
}

export function buildWorkPlanModel(
  diagnosis: DiagnosisSnapshotViewModel,
  draft: ActionDraftViewModel | null,
  planDepth: CaseSolveModeValue
): WorkPlanModel {
  const traceKeys = diagnosis.trace.map((e) => e.claimKey).filter(Boolean);
  const nextProof = proofRotator(traceKeys);

  const draftStale =
    draft !== null && draft.diagnosisSnapshotId !== diagnosis.id;

  const readiness: WorkPlanReadiness =
    draft?.type === "fix"
      ? "fix"
      : draft !== null
        ? "investigation"
        : diagnosis.confidence === "likely" && diagnosis.nextActionMode === "fix"
          ? "fix"
          : "investigation";

  const strapline = draft?.title?.trim()
    ? clampTail(draft.title.trim(), 76)
    : clampTail(diagnosis.summary, 96);

  const planDepthFraming = planDepthFramingLine(planDepth);

  const immediateRationale = draft?.whyNow?.trim()
    ? clampTail(draft.whyNow, 132)
    : clampTail(diagnosis.summary, 112);

  const immediate: WorkPlanTask = {
    title: clampTail(diagnosis.nextActionText, 108),
    rationale: immediateRationale,
    taskType: modeToTaskType(diagnosis.nextActionMode),
    proofClaimKey: nextProof(),
    doneCondition: doneForMode(diagnosis.nextActionMode),
  };

  const groups: WorkPlanGroup[] = [
    { id: "immediate", title: "Immediate next move", tasks: [immediate] },
  ];

  const coreTasks: WorkPlanTask[] = [];
  if (draft?.suggestedSteps?.length) {
    for (const step of draft.suggestedSteps) {
      const { title, rationale } = splitStep(step);
      coreTasks.push({
        title: title || clampTail(step, 80),
        rationale:
          rationale ||
          (draft.type === "fix"
            ? "Concrete move toward stability."
            : "Narrows uncertainty before you commit."),
        taskType: draft.type === "fix" ? "fix" : "investigate",
        proofClaimKey: nextProof(),
      });
    }
  } else if (draft) {
    coreTasks.push({
      title: clampTail(draft.title, 86),
      rationale: clampTail(draft.summary, 156),
      taskType: draft.type === "fix" ? "fix" : "investigate",
      proofClaimKey: nextProof(),
    });
  } else if (diagnosis.confidence === "unclear") {
    coreTasks.push({
      title: "Sharpen the read first",
      rationale:
        "Draft checklists stay off until confidence clears—add evidence or finish the run’s questions.",
      taskType: "investigate",
      proofClaimKey: null,
      doneCondition: "Re-analysis shows likely or plausible confidence.",
    });
  } else {
    coreTasks.push({
      title: "Generate a saved checklist",
      rationale:
        "Captures steps against this snapshot—open Review & save to edit or pin.",
      taskType: "investigate",
      proofClaimKey: null,
      doneCondition: "Draft appears in Review & save.",
    });
  }

  groups.push({ id: "core", title: coreGroupTitle(planDepth), tasks: coreTasks });

  const validationTasks: WorkPlanTask[] = [];
  if (draft?.type === "fix") {
    validationTasks.push({
      title: clampTail(
        `Re-run the failing path in ${diagnosis.affectedArea}`,
        98
      ),
      rationale: "Confirms the change where the pain showed up.",
      taskType: "validate",
      proofClaimKey: nextProof(),
      doneCondition: "Same scenario; outcome improved or stable.",
    });
  } else {
    validationTasks.push({
      title: "Hold one decisive check",
      rationale:
        "One log slice, metric, or repro that confirms or falsifies the theory.",
      taskType: "validate",
      proofClaimKey: nextProof(),
      doneCondition: "Signal maps cleanly to the read.",
    });
  }

  if (draft) {
    for (const m of diagnosis.missingEvidence.slice(0, 2)) {
      validationTasks.push({
        title: clampTail(m, 82),
        rationale: "Closes a gap named in this snapshot.",
        taskType: "validate",
        proofClaimKey: null,
        doneCondition: "On the case before the next read.",
      });
    }
  }

  if (!draft && diagnosis.missingEvidence.length > 0) {
    for (const m of diagnosis.missingEvidence.slice(0, 2)) {
      validationTasks.push({
        title: clampTail(m, 82),
        rationale: "Needed to tighten the next read.",
        taskType: "validate",
        proofClaimKey: null,
        doneCondition: "Attached, then re-run analysis.",
      });
    }
  }

  groups.push({
    id: "validation",
    title: validationGroupTitle(planDepth),
    tasks: validationTasks,
  });

  const followTasks: WorkPlanTask[] = [];
  if (draft?.risksOrUnknowns?.length) {
    for (const r of draft.risksOrUnknowns.slice(0, 4)) {
      followTasks.push({
        title: clampTail(r, 86),
        rationale: "Keep visible so scope does not drift.",
        taskType: "follow_up",
        proofClaimKey: null,
        doneCondition: "Explicitly owned, deferred, or cleared.",
      });
    }
  }

  for (let i = 0; i < Math.min(1, diagnosis.contradictions.length); i += 1) {
    const c = diagnosis.contradictions[i];
    followTasks.push({
      title: clampTail(c, 86),
      rationale: "Resolve or document before wide rollout.",
      taskType: "follow_up",
      proofClaimKey: `contradiction-${i}`,
      doneCondition: "Tension explained in proof or new evidence.",
    });
  }

  if (followTasks.length > 0) {
    groups.push({
      id: "follow_up",
      title: followUpGroupTitle(planDepth),
      tasks: followTasks,
    });
  }

  return {
    readiness,
    strapline,
    planDepthFraming,
    groups,
    draftStale,
    hasDraft: draft !== null,
  };
}
