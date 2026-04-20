import { DIAGNOSIS_CONFIDENCE_LABELS } from "@/lib/analysis/constants";
import type {
  ActionDraftViewModel,
  DiagnosisSnapshotViewModel,
} from "@/lib/analysis/view-model";

export type WhyThisPlanCluster = {
  id: string;
  label: string;
  items: Array<{ claimKey: string; claim: string }>;
};

export type WhyThisPlanAlternative = {
  title: string;
  confidenceLabel: string;
  reasoning: string;
};

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

/** Plan-choice framing—does not restate working theory or duplicate plan steps. */
export function whyPlanRationale(
  diagnosis: DiagnosisSnapshotViewModel,
  draft: ActionDraftViewModel | null
): string {
  const { nextActionMode, affectedArea, confidence } = diagnosis;
  const area = affectedArea.trim() || "this surface";
  const confWord = DIAGNOSIS_CONFIDENCE_LABELS[confidence].toLowerCase();

  let shape: string;
  if (nextActionMode === "fix") {
    shape = `Targ favors a change-first sequence here: confidence is ${confWord} for a bounded intervention in ${area}, not an open-ended chase.`;
  } else if (nextActionMode === "verify") {
    shape = `Targ favors proving the signal before code moves: ${confWord} read on ${area}, so the plan earns a checkpoint before you ship.`;
  } else {
    shape = `Targ holds the plan in ask-mode until you unblock a fact the evidence can’t supply—anything louder would be overfit.`;
  }

  const planTie = draft
    ? draft.type === "fix"
      ? " That matches the fix-ready plan above."
      : " That matches the investigation-ready plan above."
    : " That matches the posture of the work plan above.";

  return clampTail(`${shape}${planTie}`, 320);
}

export function buildTraceClusters(
  diagnosis: DiagnosisSnapshotViewModel
): WhyThisPlanCluster[] {
  const trace = diagnosis.trace;
  if (trace.length === 0) {
    return [];
  }

  const mapItem = (e: (typeof trace)[0]) => ({
    claimKey: e.claimKey,
    claim: clampTail(e.claim, 160),
  });

  if (trace.length === 1) {
    return [
      {
        id: "primary",
        label: "Signal behind this path",
        items: [mapItem(trace[0])],
      },
    ];
  }

  const primary = trace[0];
  const rest = trace.slice(1, 5);
  const clusters: WhyThisPlanCluster[] = [
    {
      id: "direction",
      label: "What sets direction",
      items: [mapItem(primary)],
    },
    {
      id: "support",
      label: "What reinforces it",
      items: rest.map(mapItem),
    },
  ];

  return clusters;
}

/** Confidence + gaps; contradictions listed separately in the UI. */
export function confidenceCeilingBase(
  diagnosis: DiagnosisSnapshotViewModel
): string {
  const label = DIAGNOSIS_CONFIDENCE_LABELS[diagnosis.confidence];
  const parts: string[] = [
    `Rated ${label} for this snapshot—not a guarantee across environments.`,
  ];

  if (diagnosis.confidence === "unclear") {
    parts.push(
      "Thin, uneven, or internally tense evidence keeps the ceiling low."
    );
  } else if (diagnosis.confidence === "plausible") {
    parts.push("Directionally useful; treat fine-grained detail as open.");
  }

  const m = diagnosis.missingEvidence.length;
  if (m > 0) {
    parts.push(
      m === 1
        ? "One cited gap would sharpen this further."
        : `${m} cited gaps would sharpen this further.`
    );
  }

  return parts.join(" ");
}

export function buildAlternatives(
  diagnosis: DiagnosisSnapshotViewModel
): WhyThisPlanAlternative[] {
  return diagnosis.hypotheses.map((h) => ({
    title: clampTail(h.title, 72),
    confidenceLabel: DIAGNOSIS_CONFIDENCE_LABELS[h.confidence],
    reasoning: clampTail(h.reasoning, 120),
  }));
}

export function buildContradictionTeasers(
  diagnosis: DiagnosisSnapshotViewModel,
  max = 2
): string[] {
  return diagnosis.contradictions.slice(0, max).map((c) => clampTail(c, 100));
}
