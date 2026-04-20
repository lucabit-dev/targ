/**
 * Deterministic fixture for the `contradiction_split_service_failure` golden
 * case, shaped as a post-diagnosis `HandoffPacketInput`.
 *
 * Used by `src/lib/handoff/render-markdown.test.ts` to lock the packet
 * contract against spec (docs/handoff-packet.md) and the worked example
 * (docs/examples/packet-contradiction-split-service.md).
 *
 * This is NOT wired into the analysis pipeline — hand-authored diagnosis text
 * lets us test the builder + renderer in isolation from the LLM path.
 */

import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";
import type { HandoffPacketInput } from "@/lib/handoff/packet";

const CASE_ID = "c_contra01";
const DIAGNOSIS_ID = "d_contra01";
const ANALYSIS_RUN_ID = "r_contra01";
const API_EVIDENCE_ID = "ev_api_log";
const WORKER_EVIDENCE_ID = "ev_worker_log";

// Frozen instant so the renderer's `_Case: … generated <ISO>_` line is stable
// across runs and platforms.
const FROZEN_NOW = new Date("2026-04-20T14:45:02.000Z");

export const CONTRADICTION_FIXTURE_EVIDENCE: EvidenceViewModel[] = [
  {
    id: API_EVIDENCE_ID,
    caseId: CASE_ID,
    kind: "log",
    source: "paste",
    ingestStatus: "ready",
    originalName: "api-log",
    mimeType: "text/plain",
    rawStorageUrl: null,
    rawText:
      "2026-04-09T00:00:00Z service=api requestId=req-600 GET /api/checkout\nError: failed\n    at submitCheckout (/srv/checkout.js:44:9)",
    redactedText:
      "2026-04-09T00:00:00Z service=api requestId=req-600 GET /api/checkout\nError: failed\n    at submitCheckout (/srv/checkout.js:44:9)",
    extracted: {
      services: ["api"],
      endpoints: ["GET /api/checkout"],
      timestamps: ["2026-04-09T00:00:00Z"],
      requestIds: ["req-600"],
      stackFrames: [
        { raw: "at submitCheckout (/srv/checkout.js:44:9)" },
      ],
    },
    caseEvidenceVersion: 1,
    createdAt: FROZEN_NOW,
    summary:
      "A GET /api/checkout request produced a 500 at submitCheckout line 44, with request id req-600.",
    parseWarnings: [],
    notices: [],
    secretsDetected: false,
  },
  {
    id: WORKER_EVIDENCE_ID,
    caseId: CASE_ID,
    kind: "terminal",
    source: "paste",
    ingestStatus: "ready",
    originalName: "worker-log",
    mimeType: "text/plain",
    rawStorageUrl: null,
    rawText:
      "service=worker\nretry loop failed\n    at runWorker (/srv/worker.js:12:2)",
    redactedText:
      "service=worker\nretry loop failed\n    at runWorker (/srv/worker.js:12:2)",
    extracted: {
      services: ["worker"],
      stackFrames: [
        { raw: "at runWorker (/srv/worker.js:12:2)" },
      ],
    },
    caseEvidenceVersion: 1,
    createdAt: FROZEN_NOW,
    summary:
      "A worker retry loop failed at runWorker line 12. No timestamp or request id is attached, so it is not clear whether it corresponds to the same request above.",
    parseWarnings: [],
    notices: [],
    secretsDetected: false,
  },
];

export const CONTRADICTION_FIXTURE_DIAGNOSIS: DiagnosisSnapshotViewModel = {
  id: DIAGNOSIS_ID,
  caseId: CASE_ID,
  analysisRunId: ANALYSIS_RUN_ID,
  caseEvidenceVersion: 1,
  problemBrief: null,
  status: "provisional",
  confidence: "unclear",
  probableRootCause:
    "Two independent failure signals are surfacing — one in the API request path (submitCheckout) and one in the worker loop (runWorker) — and the current evidence does not show which one is causing the other.",
  affectedArea: "checkout flow across the API and worker layers",
  summary:
    "Two independent failure signals are surfacing — one in the API request path (submitCheckout) and one in the worker loop (runWorker) — and the current evidence does not show which one is causing the other.",
  trace: [
    {
      claimKey: "api_500",
      claim: "The API returns 500 on GET /api/checkout with stack at submitCheckout:44.",
      evidence: "api-log",
    },
    {
      claimKey: "worker_failed",
      claim: "The worker retry loop failed at runWorker:12 with no request id.",
      evidence: "worker-log",
    },
  ],
  hypotheses: [
    {
      title: "The worker retry loop is the cause; the API 500 is a downstream symptom",
      confidence: "plausible",
      reasoning:
        "If the worker is failing to process a payment-related job, submitCheckout could fall through to a 500 when it reads an empty or errored worker result.",
    },
    {
      title: "The API failure is the cause; the worker failure is unrelated",
      confidence: "unclear",
      reasoning:
        "submitCheckout throws before the worker is ever invoked for this request, and the worker log is from a separate job. The two logs are co-occurring by chance.",
    },
    {
      title:
        "Both are symptoms of a shared dependency failure (upstream provider or config)",
      confidence: "unclear",
      reasoning:
        "Neither log contains env hints, provider names, or config values, so a common dependency outage cannot be ruled out without more signal.",
    },
  ],
  contradictions: [
    "The API log and the worker log describe failures at different frames with no shared request identifier to tie them together.",
  ],
  missingEvidence: [
    "A worker log entry containing req-600, so the two failures can be tied together or separated.",
    "Whether there was a deploy, config change, or provider incident in the last 24 hours that touched both the API and the worker.",
    "A submitCheckout trace showing whether it depends on the worker path synchronously or not.",
  ],
  nextActionMode: "request_input",
  nextActionText:
    "Add one piece of evidence that either ties the two failures together or clearly separates them: either a worker log entry containing req-600, or a submitCheckout trace showing whether it depends on the worker path.",
  claimReferences: [
    {
      id: "cr_api_support",
      claimKey: "api_500",
      claimText: "The API returns 500 on GET /api/checkout with stack at submitCheckout line 44.",
      relation: "supports",
      evidenceId: API_EVIDENCE_ID,
      evidenceName: "api-log",
      sourceLabel: "paste",
      summary:
        "GET /api/checkout produced a 500 with a stack rooted at submitCheckout.",
      excerpt: "Error: failed\n    at submitCheckout (/srv/checkout.js:44:9)",
    },
    {
      id: "cr_worker_support",
      claimKey: "worker_failed",
      claimText:
        "A worker retry loop failed at runWorker line 12 with no timestamp or request id.",
      relation: "supports",
      evidenceId: WORKER_EVIDENCE_ID,
      evidenceName: "worker-log",
      sourceLabel: "paste",
      summary:
        "A worker retry loop failed at runWorker, carrying no request-id linkage to the API log.",
      excerpt: "retry loop failed\n    at runWorker (/srv/worker.js:12:2)",
    },
    {
      id: "cr_api_weakens_worker_cause",
      claimKey: "api_500",
      claimText:
        "No request id in the worker log to confirm the link to the API 500 on req-600.",
      relation: "weakens",
      evidenceId: API_EVIDENCE_ID,
      evidenceName: "api-log",
      sourceLabel: "paste",
      summary:
        "API log carries req-600, but the worker log has no request id to cross-check against.",
      excerpt: "requestId=req-600 GET /api/checkout",
    },
  ],
  createdAt: FROZEN_NOW,
};

export const CONTRADICTION_FIXTURE_INPUT: HandoffPacketInput = {
  caseRecord: {
    id: CASE_ID,
    title: "API and worker evidence disagree on the failing boundary",
    userProblemStatement:
      "Checkout failures look split across the API and worker layers.",
    severity: null,
    problemLens: null,
    solveMode: null,
  },
  diagnosis: CONTRADICTION_FIXTURE_DIAGNOSIS,
  evidence: CONTRADICTION_FIXTURE_EVIDENCE,
  generator: {
    caseUrl: `https://targ.app/cases/${CASE_ID}`,
    generatorVersion: "targ-handoff/1.0.0",
    now: FROZEN_NOW,
  },
};

export const CONTRADICTION_FIXTURE_META = {
  caseId: CASE_ID,
  diagnosisId: DIAGNOSIS_ID,
  apiEvidenceId: API_EVIDENCE_ID,
  workerEvidenceId: WORKER_EVIDENCE_ID,
  frozenNow: FROZEN_NOW,
};
