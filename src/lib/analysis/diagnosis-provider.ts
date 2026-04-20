import type { AnalysisRunAnswerRecord } from "@/lib/analysis/view-model";
import type { DiagnosisSnapshotPayload } from "@/lib/validators";
import { diagnosisSnapshotPayloadSchema } from "@/lib/validators";

type GeneratedDiagnosisResult = {
  diagnosis: DiagnosisSnapshotPayload;
  provider: "openai_responses" | "deterministic";
  model: string | null;
  note: string | null;
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const DIAGNOSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "confidence",
    "probable_root_cause",
    "affected_area",
    "summary",
    "trace",
    "hypotheses",
    "contradictions",
    "missing_evidence",
    "next_action_mode",
    "next_action_text",
    "claim_references",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["provisional", "revised"],
    },
    confidence: {
      type: "string",
      enum: ["likely", "plausible", "unclear"],
    },
    probable_root_cause: {
      type: "string",
      minLength: 1,
      maxLength: 500,
    },
    affected_area: {
      type: "string",
      minLength: 1,
      maxLength: 240,
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
    },
    trace: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidence"],
        properties: {
          claim: {
            type: "string",
            minLength: 1,
            maxLength: 280,
          },
          evidence: {
            type: "string",
            minLength: 1,
            maxLength: 500,
          },
        },
      },
    },
    hypotheses: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "confidence", "reasoning"],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
          confidence: {
            type: "string",
            enum: ["likely", "plausible", "unclear"],
          },
          reasoning: {
            type: "string",
            minLength: 1,
            maxLength: 600,
          },
        },
      },
    },
    contradictions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 400,
      },
    },
    missing_evidence: {
      type: "array",
      maxItems: 8,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 280,
      },
    },
    next_action_mode: {
      type: "string",
      enum: ["fix", "verify", "request_input"],
    },
    next_action_text: {
      type: "string",
      minLength: 1,
      maxLength: 500,
    },
    claim_references: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidenceIds"],
        properties: {
          claim: {
            type: "string",
            minLength: 1,
            maxLength: 280,
          },
          evidenceIds: {
            type: "array",
            maxItems: 8,
            items: {
              type: "string",
              minLength: 1,
            },
          },
        },
      },
    },
  },
} as const;

function extractOutputText(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const response = value as Record<string, unknown>;

  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text;
  }

  const output = Array.isArray(response.output) ? response.output : [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as Array<Record<string, unknown>>)
      : [];

    for (const chunk of content) {
      if (chunk.type === "output_text" && typeof chunk.text === "string") {
        return chunk.text;
      }
    }
  }

  return null;
}

function extractRefusal(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const response = value as Record<string, unknown>;
  const output = Array.isArray(response.output) ? response.output : [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as Array<Record<string, unknown>>)
      : [];

    for (const chunk of content) {
      if (chunk.type === "refusal" && typeof chunk.refusal === "string") {
        return chunk.refusal;
      }
    }
  }

  return null;
}

function compactAnswers(answers: AnalysisRunAnswerRecord[]) {
  return answers.map((answer) => ({
    question: answer.question,
    answer: answer.answer,
  }));
}

export async function generateDiagnosisSnapshot(params: {
  prompt: string;
  caseMemory: Record<string, unknown>;
  answers: AnalysisRunAnswerRecord[];
  heuristicDiagnosis: DiagnosisSnapshotPayload;
}): Promise<GeneratedDiagnosisResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.TARG_ANALYSIS_MODEL ?? "gpt-4o-mini";

  if (!apiKey) {
    return {
      diagnosis: params.heuristicDiagnosis,
      provider: "deterministic",
      model: null,
      note: "OPENAI_API_KEY is not configured, so Targ used the deterministic diagnosis path.",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_output_tokens: 2200,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: params.prompt,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(
                  {
                    instructions: [
                      "Return only the structured diagnosis object.",
                      "Do not invent evidence or evidence ids.",
                      "If the evidence is weak, set confidence to unclear or plausible and push missing evidence into missing_evidence.",
                      "Keep summaries concise and grounded.",
                    ],
                    answers: compactAnswers(params.answers),
                    heuristic_candidate: params.heuristicDiagnosis,
                    case_packet: params.caseMemory,
                  },
                  null,
                  2
                ),
              },
            ],
          },
        ],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "targ_diagnosis_snapshot",
            strict: true,
            description:
              "Grounded diagnosis snapshot for Targ, based only on the provided case memory and evidence.",
            schema: DIAGNOSIS_JSON_SCHEMA,
          },
        },
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "OpenAI rejected the configured API key."
          : "OpenAI did not return a usable diagnosis."
      );
    }

    const refusal = extractRefusal(payload);
    if (refusal) {
      throw new Error(`The model refused the diagnosis request: ${refusal}`);
    }

    const outputText = extractOutputText(payload);
    if (!outputText) {
      throw new Error("The model response did not include structured output text.");
    }

    const json = JSON.parse(outputText) as unknown;
    const parsed = diagnosisSnapshotPayloadSchema.safeParse(json);

    if (!parsed.success) {
      throw new Error(
        parsed.error.issues[0]?.message ??
          "The model returned a diagnosis that did not match the expected schema."
      );
    }

    return {
      diagnosis: parsed.data,
      provider: "openai_responses",
      model,
      note: `Generated with ${model} via the OpenAI Responses API.`,
    };
  } catch (error) {
    return {
      diagnosis: params.heuristicDiagnosis,
      provider: "deterministic",
      model,
      note:
        error instanceof Error
          ? `Model diagnosis failed, so Targ used the deterministic fallback. ${error.message}`
          : "Model diagnosis failed, so Targ used the deterministic fallback.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
