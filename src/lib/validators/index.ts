import { z } from "zod";

import {
  workspacePlaybookSchema,
} from "@/lib/workspace/playbook";

export const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;

export const signupInputSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters."),
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be 80 characters or less."),
});

export const loginInputSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1, "Password is required."),
});

export const createWorkspaceInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Workspace name must be at least 2 characters.")
    .max(80, "Workspace name must be 80 characters or less."),
});

export const updateWorkspacePlaybookInputSchema = workspacePlaybookSchema;

export const caseSolveModeInputSchema = z.enum([
  "quick_patch",
  "proper_fix",
  "strategic_improvement",
]);

export const caseProblemLensInputSchema = z.enum([
  "code",
  "ux_ui",
  "product",
  "doctrine",
  "mixed",
]);

export const patchCaseSolveModeSchema = z.object({
  solveMode: caseSolveModeInputSchema,
});

export const createCaseInputSchema = z.object({
  title: z
    .string()
    .trim()
    .max(160, "Title must be 160 characters or less.")
    .optional()
    .or(z.literal("")),
  userProblemStatement: z
    .string()
    .trim()
    .min(1, "Describe the issue before creating a case.")
    .max(10000, "Problem statement must be 10000 characters or less."),
  workspaceId: z.string().trim().optional(),
  /** Optional: how aggressively to plan execution vs investigation. */
  solveMode: caseSolveModeInputSchema.optional(),
  /** Optional: problem lens override; omit for auto-detection. */
  problemLens: caseProblemLensInputSchema.optional(),
});

export const evidenceKindSchema = z.enum([
  "log",
  "screenshot",
  "error_text",
  "terminal",
  "note",
  "code",
]);

export const evidenceSourceSchema = z.enum(["upload", "paste", "manual_note"]);

export const createTextEvidenceInputSchema = z.object({
  kind: z.enum(["log", "error_text", "terminal", "note", "code"]),
  source: evidenceSourceSchema,
  originalName: z
    .string()
    .trim()
    .min(1, "Evidence name is required.")
    .max(200, "Evidence name must be 200 characters or less.")
    .optional()
    .default("Pasted evidence"),
  rawText: z
    .string()
    .trim()
    .min(1, "Paste or write evidence before saving.")
    .max(100000, "Evidence text must be 100000 characters or less."),
});

export const presignUploadInputSchema = z.object({
  caseId: z.string().trim().min(1),
  originalName: z
    .string()
    .trim()
    .min(1, "File name is required.")
    .max(240, "File name must be 240 characters or less."),
  mimeType: z
    .string()
    .trim()
    .max(120, "MIME type must be 120 characters or less.")
    .optional(),
  size: z.number().int().nonnegative().max(MAX_UPLOAD_SIZE_BYTES).optional(),
});

export const diagnosisConfidenceSchema = z.enum([
  "likely",
  "plausible",
  "unclear",
]);

export const diagnosisNextActionModeSchema = z.enum([
  "fix",
  "verify",
  "request_input",
]);

export const diagnosisTraceEntrySchema = z
  .object({
    claim: z.string().trim().min(1).max(280),
    evidence: z.string().trim().min(1).max(500),
  })
  .strict();

export const diagnosisHypothesisSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    confidence: diagnosisConfidenceSchema,
    reasoning: z.string().trim().min(1).max(600),
  })
  .strict();

export const diagnosisClaimReferenceSchema = z
  .object({
    claim: z.string().trim().min(1).max(280),
    evidenceIds: z.array(z.string().trim().min(1)).max(8),
  })
  .strict();

export const diagnosisSnapshotPayloadSchema = z
  .object({
    status: z.enum(["provisional", "revised"]),
    confidence: diagnosisConfidenceSchema,
    probable_root_cause: z.string().trim().min(1).max(500),
    affected_area: z.string().trim().min(1).max(240),
    summary: z.string().trim().min(1).max(1000),
    trace: z.array(diagnosisTraceEntrySchema).min(1).max(8),
    hypotheses: z.array(diagnosisHypothesisSchema).min(1).max(5),
    contradictions: z.array(z.string().trim().min(1).max(400)).max(8),
    missing_evidence: z.array(z.string().trim().min(1).max(280)).max(8),
    next_action_mode: diagnosisNextActionModeSchema,
    next_action_text: z.string().trim().min(1).max(500),
    claim_references: z.array(diagnosisClaimReferenceSchema).min(1).max(8),
  })
  .strict();

export const runAnswerInputSchema = z.object({
  answer: z.string().trim().min(1, "Choose an answer before continuing."),
});

export const actionDraftTypeSchema = z.enum(["fix", "investigation"]);

export const actionDraftStatusSchema = z.enum([
  "drafted",
  "saved",
  "sent",
  "dismissed",
]);

export const actionDraftPayloadSchema = z
  .object({
    type: actionDraftTypeSchema,
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(700),
    whyNow: z.string().trim().min(1).max(500),
    urgency: z.string().trim().min(1).max(80),
    suggestedSteps: z.array(z.string().trim().min(1).max(280)).min(1).max(3),
    risksOrUnknowns: z.array(z.string().trim().min(1).max(280)).max(6),
    linkedEvidenceIds: z.array(z.string().trim().min(1)).max(8),
    status: actionDraftStatusSchema,
  })
  .strict();

export const updateDraftInputSchema = z
  .object({
    status: actionDraftStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one draft field to update.",
  });

export const handoffTargetInputSchema = z.enum([
  "cursor",
  "claude_code",
  "codex",
  "copilot_ws",
  "github_issue",
  "linear_issue",
  "markdown",
]);

export const createHandoffInputSchema = z
  .object({
    target: handoffTargetInputSchema,
    diagnosisId: z.string().trim().min(1).optional(),
    workBundleId: z.string().trim().min(1).optional(),
  })
  .strict();

// GitHub owner and repo names: GitHub allows alphanumerics, hyphens, underscores
// and dots; owner may also include dots; we keep the regex permissive but
// reject obvious separators to avoid injection into API URLs.
const githubNameSegmentRegex = /^[A-Za-z0-9._-]+$/;

export const connectRepoInputSchema = z
  .object({
    owner: z
      .string()
      .trim()
      .min(1, "Repository owner is required.")
      .max(120)
      .regex(githubNameSegmentRegex, "Invalid repository owner."),
    name: z
      .string()
      .trim()
      .min(1, "Repository name is required.")
      .max(120)
      .regex(githubNameSegmentRegex, "Invalid repository name."),
  })
  .strict();

/// Accepts either the structured `{ owner, name }` form or a single `fullName`
/// string (e.g. "vercel/next.js"), which the parser splits on `/`.
export const connectRepoRequestSchema = z
  .union([
    connectRepoInputSchema,
    z
      .object({
        fullName: z
          .string()
          .trim()
          .min(3)
          .max(240)
          .regex(
            /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
            "Use the format owner/name."
          ),
      })
      .strict()
      .transform(({ fullName }) => {
        const [owner, name] = fullName.split("/", 2);
        return { owner, name };
      }),
  ]);

export type SignupInput = z.infer<typeof signupInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;
export type UpdateWorkspacePlaybookInput = z.infer<
  typeof updateWorkspacePlaybookInputSchema
>;
export type CreateCaseInput = z.infer<typeof createCaseInputSchema>;
export type EvidenceKindInput = z.infer<typeof evidenceKindSchema>;
export type EvidenceSourceInput = z.infer<typeof evidenceSourceSchema>;
export type CreateTextEvidenceInput = z.infer<typeof createTextEvidenceInputSchema>;
export type PresignUploadInput = z.infer<typeof presignUploadInputSchema>;
export type DiagnosisSnapshotPayload = z.infer<
  typeof diagnosisSnapshotPayloadSchema
>;
export type DiagnosisConfidence = z.infer<typeof diagnosisConfidenceSchema>;
export type DiagnosisNextActionMode = z.infer<
  typeof diagnosisNextActionModeSchema
>;
export type RunAnswerInput = z.infer<typeof runAnswerInputSchema>;
export type ActionDraftPayload = z.infer<typeof actionDraftPayloadSchema>;
export type ActionDraftType = z.infer<typeof actionDraftTypeSchema>;
export type ActionDraftStatus = z.infer<typeof actionDraftStatusSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftInputSchema>;
export type HandoffTargetInput = z.infer<typeof handoffTargetInputSchema>;
export type CreateHandoffInput = z.infer<typeof createHandoffInputSchema>;
export type ConnectRepoInputValidated = z.infer<typeof connectRepoInputSchema>;
export type ConnectRepoRequestValidated = z.infer<typeof connectRepoRequestSchema>;
