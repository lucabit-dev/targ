import {
  EVIDENCE_INGEST_STATUS_LABELS,
  EVIDENCE_KIND_LABELS,
} from "@/lib/evidence/constants";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";
import { formatRelativeDate } from "@/lib/utils/format";
import { Chip, Surface } from "@/components/ui/primitives";

type EvidenceInventoryProps = {
  evidence: EvidenceViewModel[];
  highlightedEvidenceIds?: string[];
  latestDiagnosisCaseEvidenceVersion?: number | null;
};

function statusClassName(status: EvidenceViewModel["ingestStatus"]) {
  if (status === "ready") {
    return "success";
  }

  if (status === "needs_review") {
    return "warning";
  }

  if (status === "unsupported" || status === "failed") {
    return "critical";
  }

  return "subtle";
}

export function EvidenceInventory({
  evidence,
  highlightedEvidenceIds = [],
  latestDiagnosisCaseEvidenceVersion = null,
}: EvidenceInventoryProps) {
  if (evidence.length === 0) {
    return (
      <Surface tone="base" padding="lg" className="targ-empty-state">
        <h2 className="targ-page-title text-[var(--color-text-primary)]">
          No evidence
        </h2>
        <p className="mx-auto mt-3 max-w-2xl targ-body">
          Add items above before analysis. Grounding needs source material.
        </p>
      </Surface>
    );
  }

  const latestEvidenceVersion = Math.max(
    ...evidence.map((item) => item.caseEvidenceVersion)
  );

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {evidence.map((item) => (
          <div key={item.id} className="shrink-0">
            <Chip>{item.originalName}</Chip>
          </div>
        ))}
      </div>

      {evidence.map((item) => (
        <Surface key={item.id} tone="base" padding="md" className="px-5 py-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-[15px] font-semibold leading-[22px] tracking-[-0.02em] text-[var(--color-text-primary)]">
                  {item.originalName}
                </div>
                <Chip>{EVIDENCE_KIND_LABELS[item.kind]}</Chip>
                <Chip tone={statusClassName(item.ingestStatus) as "subtle" | "success" | "warning" | "critical"}>
                  {EVIDENCE_INGEST_STATUS_LABELS[item.ingestStatus]}
                </Chip>
                {highlightedEvidenceIds.includes(item.id) ? (
                  <Chip tone="confidence">Used in diagnosis</Chip>
                ) : null}
                {latestDiagnosisCaseEvidenceVersion !== null &&
                item.caseEvidenceVersion > latestDiagnosisCaseEvidenceVersion ? (
                  <Chip tone="warning">New since diagnosis</Chip>
                ) : null}
                {item.caseEvidenceVersion === latestEvidenceVersion ? (
                  <Chip>Latest batch</Chip>
                ) : null}
              </div>

              {item.summary ? (
                <p className="mt-3 targ-body">
                  {item.summary}
                </p>
              ) : null}
            </div>

            <div className="targ-meta">
              Added {formatRelativeDate(item.createdAt)}
            </div>
          </div>

          {item.parseWarnings.length > 0 ? (
            <div className="mt-4 space-y-2">
              {item.parseWarnings.map((warning) => (
                <div
                  key={`${item.id}-${warning}`}
                  className="targ-callout-warn text-sm"
                >
                  {warning}
                </div>
              ))}
            </div>
          ) : null}

          {item.notices.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {item.notices.map((notice) => (
                <Chip key={`${item.id}-${notice}`}>
                  {notice}
                </Chip>
              ))}
            </div>
          ) : null}
        </Surface>
      ))}
    </div>
  );
}
