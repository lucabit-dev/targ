import type {
  EvidenceIngestStatusValue,
  EvidenceKindValue,
  EvidenceSourceValue,
} from "@/lib/evidence/constants";

export type EvidenceViewModel = {
  id: string;
  caseId: string;
  kind: EvidenceKindValue;
  source: EvidenceSourceValue;
  ingestStatus: EvidenceIngestStatusValue;
  originalName: string;
  mimeType: string | null;
  rawStorageUrl: string | null;
  rawText: string | null;
  redactedText: string | null;
  extracted: Record<string, unknown> | null;
  caseEvidenceVersion: number;
  createdAt: Date | string;
  summary: string | null;
  parseWarnings: string[];
  notices: string[];
  secretsDetected: boolean;
};
