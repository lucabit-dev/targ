import { z } from "zod";

import type {
  CaseProblemLensValue,
  CaseSolveModeValue,
} from "@/lib/planning/intake-preferences";

export const workspaceTeamProfileSchema = z.enum([
  "engineering",
  "product",
  "design",
  "support_ops",
  "cross_functional",
]);

export const workspaceAnalysisBiasSchema = z.enum([
  "fast_action",
  "balanced",
  "high_confidence",
]);

export const workspaceOutputStyleSchema = z.enum([
  "tasks_only",
  "diagnosis_plus_tasks",
  "handoff_plan",
  "executive_summary",
]);

export const workspaceEvidenceProfileSchema = z.enum([
  "logs_terminal",
  "screenshots_ui",
  "user_reports",
  "mixed",
]);

export const workspaceOutcomeDestinationSchema = z.enum([
  "stay_in_targ",
  "export_to_bunzi",
  "handoff_copy",
  "undecided",
]);

export const workspacePlaybookSchema = z.object({
  version: z.literal(1),
  teamProfile: workspaceTeamProfileSchema,
  analysisBias: workspaceAnalysisBiasSchema,
  outputStyle: workspaceOutputStyleSchema,
  evidenceProfile: workspaceEvidenceProfileSchema,
  outcomeDestination: workspaceOutcomeDestinationSchema,
});

export type WorkspaceTeamProfile = z.infer<typeof workspaceTeamProfileSchema>;
export type WorkspaceAnalysisBias = z.infer<typeof workspaceAnalysisBiasSchema>;
export type WorkspaceOutputStyle = z.infer<typeof workspaceOutputStyleSchema>;
export type WorkspaceEvidenceProfile = z.infer<typeof workspaceEvidenceProfileSchema>;
export type WorkspaceOutcomeDestination = z.infer<
  typeof workspaceOutcomeDestinationSchema
>;
export type WorkspacePlaybook = z.infer<typeof workspacePlaybookSchema>;

type Option<T extends string> = {
  id: T;
  label: string;
  body: string;
};

export const WORKSPACE_TEAM_PROFILE_OPTIONS: Option<WorkspaceTeamProfile>[] = [
  {
    id: "engineering",
    label: "Engineering",
    body: "Focus on runtime boundaries, logs, traces, and concrete fix or verify work.",
  },
  {
    id: "product",
    label: "Product",
    body: "Focus on expected behavior, workflow outcomes, scope, and decision framing.",
  },
  {
    id: "design",
    label: "Design / UX",
    body: "Focus on visible states, flows, copy, and recovery experience around the issue.",
  },
  {
    id: "support_ops",
    label: "Support / Ops",
    body: "Focus on incident triage, customer impact, severity, and safe next steps.",
  },
  {
    id: "cross_functional",
    label: "Cross-functional",
    body: "Balance product, design, engineering, and investigation in one shared read.",
  },
];

export const WORKSPACE_ANALYSIS_BIAS_OPTIONS: Option<WorkspaceAnalysisBias>[] = [
  {
    id: "fast_action",
    label: "Fastest path",
    body: "Bias toward the smallest safe next move, even when the read is still partial.",
  },
  {
    id: "balanced",
    label: "Balanced",
    body: "Balance diagnosis quality with actionable next work.",
  },
  {
    id: "high_confidence",
    label: "Highest confidence",
    body: "Prefer stronger evidence and explicit unknowns before recommending execution-heavy work.",
  },
];

export const WORKSPACE_OUTPUT_STYLE_OPTIONS: Option<WorkspaceOutputStyle>[] = [
  {
    id: "tasks_only",
    label: "Direct tasks",
    body: "Keep the output lean and action-first.",
  },
  {
    id: "diagnosis_plus_tasks",
    label: "Diagnosis + tasks",
    body: "Lead with the read, then show the work to solve it.",
  },
  {
    id: "handoff_plan",
    label: "Handoff plan",
    body: "Package the result so another teammate or system can execute it cleanly.",
  },
  {
    id: "executive_summary",
    label: "Summary + tasks",
    body: "Frame the risk and recommendation before the task system.",
  },
];

export const WORKSPACE_EVIDENCE_PROFILE_OPTIONS: Option<WorkspaceEvidenceProfile>[] = [
  {
    id: "logs_terminal",
    label: "Logs / terminal",
    body: "Assume most cases come with traces, terminal captures, or raw debug output.",
  },
  {
    id: "screenshots_ui",
    label: "Screens / UI states",
    body: "Assume most cases start from visible product states and screenshots.",
  },
  {
    id: "user_reports",
    label: "User reports / notes",
    body: "Assume most cases start from plain-language observations and manual context.",
  },
  {
    id: "mixed",
    label: "Mixed evidence",
    body: "Expect a blend of logs, screenshots, notes, and conflicting signals.",
  },
];

export const WORKSPACE_OUTCOME_DESTINATION_OPTIONS: Option<WorkspaceOutcomeDestination>[] = [
  {
    id: "stay_in_targ",
    label: "Stay in Targ",
    body: "Keep the work self-contained in the case.",
  },
  {
    id: "export_to_bunzi",
    label: "Export to BUNZI",
    body: "Shape tasks so they transfer cleanly into your CRM workflow later.",
  },
  {
    id: "handoff_copy",
    label: "Copy as handoff",
    body: "Bias toward sharable wording and explicit next-owner context.",
  },
  {
    id: "undecided",
    label: "Still deciding",
    body: "Keep the package flexible until the destination is clear.",
  },
];

export const WORKSPACE_PLAYBOOK_DEFAULTS: WorkspacePlaybook = {
  version: 1,
  teamProfile: "engineering",
  analysisBias: "balanced",
  outputStyle: "diagnosis_plus_tasks",
  evidenceProfile: "mixed",
  outcomeDestination: "stay_in_targ",
};

export function parseWorkspacePlaybook(value: unknown): WorkspacePlaybook | null {
  const parsed = workspacePlaybookSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function workspacePlaybookSummary(playbook: WorkspacePlaybook) {
  return {
    team:
      WORKSPACE_TEAM_PROFILE_OPTIONS.find((item) => item.id === playbook.teamProfile)
        ?.label ?? playbook.teamProfile,
    analysisBias:
      WORKSPACE_ANALYSIS_BIAS_OPTIONS.find(
        (item) => item.id === playbook.analysisBias
      )?.label ?? playbook.analysisBias,
    outputStyle:
      WORKSPACE_OUTPUT_STYLE_OPTIONS.find(
        (item) => item.id === playbook.outputStyle
      )?.label ?? playbook.outputStyle,
    evidenceProfile:
      WORKSPACE_EVIDENCE_PROFILE_OPTIONS.find(
        (item) => item.id === playbook.evidenceProfile
      )?.label ?? playbook.evidenceProfile,
    outcomeDestination:
      WORKSPACE_OUTCOME_DESTINATION_OPTIONS.find(
        (item) => item.id === playbook.outcomeDestination
      )?.label ?? playbook.outcomeDestination,
  };
}

export function deriveCaseDefaultsFromPlaybook(playbook: WorkspacePlaybook): {
  solveMode: CaseSolveModeValue;
  problemLens: CaseProblemLensValue | null;
} {
  let solveMode: CaseSolveModeValue = "proper_fix";
  let problemLens: CaseProblemLensValue | null = null;

  if (playbook.analysisBias === "fast_action") {
    solveMode = "quick_patch";
  } else if (
    playbook.analysisBias === "high_confidence" &&
    playbook.teamProfile === "cross_functional"
  ) {
    solveMode = "strategic_improvement";
  }

  switch (playbook.teamProfile) {
    case "engineering":
      problemLens = "code";
      break;
    case "product":
      problemLens = "product";
      break;
    case "design":
      problemLens = "ux_ui";
      break;
    case "support_ops":
      problemLens = playbook.evidenceProfile === "logs_terminal" ? "code" : "mixed";
      break;
    case "cross_functional":
      problemLens = "mixed";
      break;
  }

  if (playbook.evidenceProfile === "screenshots_ui" && playbook.teamProfile !== "product") {
    problemLens = "ux_ui";
  } else if (
    playbook.evidenceProfile === "logs_terminal" &&
    playbook.teamProfile !== "design" &&
    playbook.teamProfile !== "product"
  ) {
    problemLens = "code";
  }

  return {
    solveMode,
    problemLens,
  };
}

export function buildPlaybookPromptDirectives(playbook: WorkspacePlaybook) {
  const lines: string[] = [];

  switch (playbook.teamProfile) {
    case "engineering":
      lines.push(
        "Prioritize runtime boundaries, logs, stack traces, reproducibility, and fix-or-verify engineering work."
      );
      break;
    case "product":
      lines.push(
        "Prioritize expected behavior, workflow outcomes, scope boundaries, and product decision clarity."
      );
      break;
    case "design":
      lines.push(
        "Prioritize visible states, user flows, recovery paths, copy clarity, and experience quality."
      );
      break;
    case "support_ops":
      lines.push(
        "Prioritize incident triage, customer impact, severity, and the safest next operational move."
      );
      break;
    case "cross_functional":
      lines.push(
        "Synthesize across product, design, engineering, and research instead of collapsing the case into one discipline too early."
      );
      break;
  }

  switch (playbook.analysisBias) {
    case "fast_action":
      lines.push(
        "Bias toward the smallest safe next move, but keep contradictions and missing evidence explicit."
      );
      break;
    case "balanced":
      lines.push(
        "Balance diagnosis quality with actionable work. Do not over-investigate when the next safe move is already clear."
      );
      break;
    case "high_confidence":
      lines.push(
        "Be conservative about implementation-heavy recommendations. Prefer verify or request_input when the grounding is still thin."
      );
      break;
  }

  switch (playbook.outputStyle) {
    case "tasks_only":
      lines.push(
        "Keep the summary concise and make the next actions highly executable."
      );
      break;
    case "diagnosis_plus_tasks":
      lines.push(
        "Lead with the diagnosis, then turn it into a concrete task system."
      );
      break;
    case "handoff_plan":
      lines.push(
        "Phrase the result so another teammate can execute it without guessing context."
      );
      break;
    case "executive_summary":
      lines.push(
        "Surface risk, user impact, and recommendation clearly before detailed task work."
      );
      break;
  }

  switch (playbook.evidenceProfile) {
    case "logs_terminal":
      lines.push(
        "Trust logs, terminal captures, timestamps, and trace continuity as primary evidence."
      );
      break;
    case "screenshots_ui":
      lines.push(
        "Treat visible state, screenshots, and context notes as first-class evidence, not secondary decoration."
      );
      break;
    case "user_reports":
      lines.push(
        "Extract expected vs actual behavior carefully from plain-language reports and call out missing specifics."
      );
      break;
    case "mixed":
      lines.push(
        "Triangulate across mixed evidence and call out conflicts instead of forcing one tidy story too early."
      );
      break;
  }

  if (playbook.outcomeDestination === "export_to_bunzi") {
    lines.push(
      "Make task titles and acceptance criteria explicit enough to transfer cleanly into a downstream execution system."
    );
  } else if (playbook.outcomeDestination === "handoff_copy") {
    lines.push(
      "Phrase outputs so they read well as a human handoff with minimal rewriting."
    );
  }

  return lines;
}
