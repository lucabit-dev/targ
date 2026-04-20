import { z } from "zod";

export const goldenCaseEvidenceSchema = z
  .object({
    kind: z.enum(["log", "screenshot", "error_text", "terminal", "note", "code"]),
    source: z.enum(["paste", "manual_note"]),
    originalName: z.string().trim().min(1).max(200),
    rawText: z.string().trim().min(1).max(100000),
  })
  .strict();

export const goldenCaseSchema = z
  .object({
    id: z.string().trim().min(1),
    category: z.enum([
      "obvious_bug",
      "contradiction",
      "insufficient_evidence",
      "false_lead",
      "multi_step_regression",
      "risky_handoff_case",
    ]),
    title: z.string().trim().min(1).max(200),
    userProblemStatement: z.string().trim().min(1).max(2000),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    evidence: z.array(goldenCaseEvidenceSchema).min(0).max(8),
    clarifyingAnswers: z.array(z.string().trim().min(1)).max(2).default([]),
    expected: z
      .object({
        confidence: z.enum(["likely", "plausible", "unclear"]),
        nextActionMode: z.enum(["fix", "verify", "request_input"]),
        draftType: z.enum(["fix", "investigation", "none"]),
        shouldAskQuestion: z.boolean(),
        riskyContradiction: z.boolean().default(false),
        majorClaimKeywords: z.array(z.string().trim().min(1)).min(1).max(8),
      })
      .strict(),
  })
  .strict();

export const evaluationDimensionScoreSchema = z
  .object({
    correctness: z.number().min(0).max(1),
    grounding: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
    questionQuality: z.number().min(0).max(1),
    actionQuality: z.number().min(0).max(1),
    schemaFidelity: z.number().min(0).max(1),
    efficiency: z.number().min(0).max(1),
  })
  .strict();

export type GoldenCase = z.infer<typeof goldenCaseSchema>;
export type EvaluationDimensionScore = z.infer<
  typeof evaluationDimensionScoreSchema
>;
