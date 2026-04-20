export const EVIDENCE_KIND_LABELS = {
  log: "Log",
  screenshot: "Screenshot",
  error_text: "Error text",
  terminal: "Terminal",
  note: "Note",
  code: "Code",
} as const;

export const EVIDENCE_SOURCE_LABELS = {
  upload: "Upload",
  paste: "Paste",
  manual_note: "Manual note",
} as const;

export const EVIDENCE_INGEST_STATUS_LABELS = {
  parsing: "Parsing",
  ready: "Ready",
  needs_review: "Needs review",
  unsupported: "Unsupported",
  failed: "Failed",
} as const;

export type EvidenceKindValue = keyof typeof EVIDENCE_KIND_LABELS;
export type EvidenceSourceValue = keyof typeof EVIDENCE_SOURCE_LABELS;
export type EvidenceIngestStatusValue = keyof typeof EVIDENCE_INGEST_STATUS_LABELS;

export const prismaEvidenceKindMap: Record<EvidenceKindValue, string> = {
  log: "LOG",
  screenshot: "SCREENSHOT",
  error_text: "ERROR_TEXT",
  terminal: "TERMINAL",
  note: "NOTE",
  code: "CODE",
};

export const prismaEvidenceSourceMap: Record<EvidenceSourceValue, string> = {
  upload: "UPLOAD",
  paste: "PASTE",
  manual_note: "MANUAL_NOTE",
};

export const prismaEvidenceIngestStatusMap: Record<EvidenceIngestStatusValue, string> = {
  parsing: "PARSING",
  ready: "READY",
  needs_review: "NEEDS_REVIEW",
  unsupported: "UNSUPPORTED",
  failed: "FAILED",
};

export function fromPrismaEvidenceKind(value: string): EvidenceKindValue {
  const entry = Object.entries(prismaEvidenceKindMap).find(
    ([, prismaValue]) => prismaValue === value
  );

  return (entry?.[0] as EvidenceKindValue | undefined) ?? "note";
}

export function fromPrismaEvidenceSource(value: string): EvidenceSourceValue {
  const entry = Object.entries(prismaEvidenceSourceMap).find(
    ([, prismaValue]) => prismaValue === value
  );

  return (entry?.[0] as EvidenceSourceValue | undefined) ?? "upload";
}

export function fromPrismaEvidenceIngestStatus(
  value: string
): EvidenceIngestStatusValue {
  const entry = Object.entries(prismaEvidenceIngestStatusMap).find(
    ([, prismaValue]) => prismaValue === value
  );

  return (entry?.[0] as EvidenceIngestStatusValue | undefined) ?? "parsing";
}
