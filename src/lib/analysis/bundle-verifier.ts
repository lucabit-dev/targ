import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";
import type {
  BreakdownDocument,
  WorkBundlePayload,
  WorkBundleTask,
} from "@/lib/planning/bundle-types";

export type BundleVerifierDecision =
  | "accept"
  | "downgrade_tasks"
  | "trim_overreach"
  | "reject_empty";

export type BundleVerifierResult = {
  ok: boolean;
  decision: BundleVerifierDecision;
  notes: string[];
  payload: WorkBundlePayload;
};

const MAX_TASKS = 14;
const MAX_GROUPS = 6;

function clonePayload(payload: WorkBundlePayload): WorkBundlePayload {
  return JSON.parse(JSON.stringify(payload)) as WorkBundlePayload;
}

/**
 * Deterministic bundle review: clarity, validation hooks, and overreach vs diagnosis.
 * No LLM — companion to diagnosis `verifier.ts`.
 */
export function verifyWorkBundle(params: {
  payload: WorkBundlePayload;
  diagnosis: DiagnosisSnapshotViewModel;
  breakdown: BreakdownDocument;
}): BundleVerifierResult {
  const notes: string[] = [];
  let decision: BundleVerifierDecision = "accept";
  const payload = clonePayload(params.payload);
  const { diagnosis } = params;

  const totalTasks = payload.taskGroups.reduce(
    (acc, g) => acc + g.tasks.length,
    0
  );

  if (payload.taskGroups.length === 0 || totalTasks === 0) {
    return {
      ok: false,
      decision: "reject_empty",
      notes: ["Work bundle has no task groups or tasks."],
      payload,
    };
  }

  if (!payload.title?.trim()) {
    payload.title = "Work bundle";
    notes.push("Filled empty bundle title.");
    decision = "downgrade_tasks";
  }

  const allowFixBundle =
    diagnosis.confidence === "likely" && diagnosis.nextActionMode === "fix";
  if (payload.kind === "fix_ready" && !allowFixBundle) {
    payload.kind = "investigation_ready";
    notes.push("Bundle kind set to investigation_ready (diagnosis policy).");
    decision = "downgrade_tasks";
  }

  if (payload.taskGroups.length > MAX_GROUPS) {
    payload.taskGroups = payload.taskGroups.slice(0, MAX_GROUPS);
    notes.push(`Trimmed task groups to ${MAX_GROUPS}.`);
    decision = "trim_overreach";
  }

  let taskCount = 0;
  const nextGroups: typeof payload.taskGroups = [];
  for (const group of payload.taskGroups) {
    const nextTasks: WorkBundleTask[] = [];
    for (const task of group.tasks) {
      if (taskCount >= MAX_TASKS) {
        break;
      }
      const hasLink =
        task.evidenceLinkIds.length > 0 ||
        (task.unknownIds?.length ?? 0) > 0 ||
        (task.hypothesisIds?.length ?? 0) > 0;

      if (!hasLink) {
        notes.push(
          `Task "${task.title}" had no evidence/unknown/hypothesis link—surface as manual review.`
        );
      }

      const allowImplement =
        diagnosis.confidence === "likely" && diagnosis.nextActionMode === "fix";

      if (task.type === "implement" && !allowImplement) {
        task.type = diagnosis.confidence === "unclear" ? "research" : "verify";
        notes.push(
          `Downgraded "${task.title}" from implement to ${task.type} (confidence or next-action policy).`
        );
        decision = "downgrade_tasks";
      }

      if (
        task.type === "implement" &&
        (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0)
      ) {
        task.acceptanceCriteria = [
          "Observable verification (test, metric, or sign-off) recorded.",
        ];
        notes.push(`Added default acceptance criteria for "${task.title}".`);
        decision = decision === "accept" ? "downgrade_tasks" : decision;
      }

      nextTasks.push(task);
      taskCount += 1;
    }
    if (nextTasks.length > 0) {
      nextGroups.push({ ...group, tasks: nextTasks });
    }
    if (taskCount >= MAX_TASKS) {
      notes.push(`Stopped adding tasks at ${MAX_TASKS} cap.`);
      decision = decision === "accept" ? "trim_overreach" : decision;
      break;
    }
  }

  payload.taskGroups = nextGroups;

  payload.taskGroups
    .sort((a, b) => a.order - b.order)
    .forEach((group, groupIndex) => {
      group.order = groupIndex + 1;
      group.tasks.forEach((task, taskIndex) => {
        task.order = taskIndex + 1;
      });
    });

  const hasImplementTask = payload.taskGroups.some((group) =>
    group.tasks.some((task) => task.type === "implement")
  );
  if (payload.kind === "fix_ready" && !hasImplementTask) {
    payload.kind = "investigation_ready";
    notes.push("Bundle kind set to investigation_ready (no implement tasks remain).");
    decision = decision === "accept" ? "downgrade_tasks" : decision;
  }

  if (
    diagnosis.contradictions.length > 0 &&
    payload.lineage.confidenceSummary.toLowerCase().includes("strong")
  ) {
    payload.lineage.confidenceSummary = `${payload.lineage.confidenceSummary} Contradictions remain—treat reading as provisional.`;
    notes.push("Softened confidence summary because contradictions exist.");
    decision = decision === "accept" ? "downgrade_tasks" : decision;
  }

  const finalCount = payload.taskGroups.reduce((a, g) => a + g.tasks.length, 0);
  const ok = finalCount > 0;

  return {
    ok,
    decision: ok ? decision : "reject_empty",
    notes,
    payload,
  };
}
