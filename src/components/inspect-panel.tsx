"use client";

import { useMemo } from "react";

import type { ClaimReferenceRelationValue } from "@/lib/analysis/constants";
import type {
  DiagnosisClaimReference,
  DiagnosisSnapshotViewModel,
} from "@/lib/analysis/view-model";
import {
  EVIDENCE_INGEST_STATUS_LABELS,
  EVIDENCE_KIND_LABELS,
} from "@/lib/evidence/constants";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";
import { Chip } from "@/components/ui/primitives";
import { cn } from "@/lib/utils/cn";

type InspectPanelProps = {
  evidence: EvidenceViewModel[];
  diagnosis: DiagnosisSnapshotViewModel | null;
  selectedClaimKey: string | null;
  activeTab: InspectTab;
  onActiveTabChange: (tab: InspectTab) => void;
};

const tabs = ["Relevant", "Uploads", "Issues"] as const;
type InspectTab = (typeof tabs)[number];
const TAB_LABELS: Record<InspectTab, string> = {
  Relevant: "Proof for this claim",
  Uploads: "All evidence",
  Issues: "Gaps & conflicts",
};

/** How this row relates to the selected claim—evidence UX, not a generic tag. */
const RELATION_PANEL: Record<
  ClaimReferenceRelationValue,
  {
    bar: string;
    pill: string;
    /** One line: what this link means for the claim. */
    bridge: string;
  }
> = {
  supports: {
    bar: "border-[rgba(111,175,123,0.45)]",
    pill: "bg-[rgba(111,175,123,0.1)] text-[#9ad5a4]",
    bridge:
      "This material supports the claim: it lines up with what Targ concluded in the read.",
  },
  weakens: {
    bar: "border-[rgba(209,107,107,0.45)]",
    pill: "bg-[rgba(209,107,107,0.12)] text-[#e08a8a]",
    bridge:
      "This material weakens or constrains the claim—use it to narrow confidence or scope.",
  },
  unclear: {
    bar: "border-[rgba(211,163,90,0.45)]",
    pill: "bg-[rgba(211,163,90,0.12)] text-[#e3bc80]",
    bridge:
      "The tie to this claim is ambiguous here; treat it as context, not a clean proof.",
  },
};

function normalizeSnippet(s: string) {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function isSubstantiallyRedundant(a: string, b: string) {
  if (!a || !b) {
    return false;
  }
  const na = normalizeSnippet(a).slice(0, 100);
  const nb = normalizeSnippet(b).slice(0, 100);
  return na === nb || na.startsWith(nb.slice(0, 50)) || nb.startsWith(na.slice(0, 50));
}

/** Short headline for the claim strip—avoid dumping full stack traces as the title. */
function claimHeadline(full: string) {
  const trimmed = full.trim();
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  const stackLike =
    lines.length >= 4 ||
    /^\s*at\s[\w$.]+/m.test(trimmed) ||
    trimmed.includes("Caused by:");

  if (stackLike && lines[0]) {
    const head = lines[0];
    return head.length > 160 ? `${head.slice(0, 159)}…` : head;
  }

  const oneLine = trimmed.replace(/\s+/g, " ");
  const dot = oneLine.search(/[.!?]\s/);
  if (dot >= 48 && dot < 200) {
    return oneLine.slice(0, dot + 1);
  }
  return oneLine.length > 180 ? `${oneLine.slice(0, 179)}…` : oneLine;
}

function excerptIsLong(text: string) {
  return text.length > 160 || text.split(/\n/).length > 4;
}

function RawExcerptBlock({ text }: { text: string }) {
  const long = excerptIsLong(text);
  const inner = (
    <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(0,0,0,0.04)]">
      <pre className="m-0 max-h-[min(40vh,13rem)] overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[10px] leading-[15px] text-[var(--color-text-muted)]">
        {text}
      </pre>
    </div>
  );

  if (!long) {
    return <div className="mt-2">{inner}</div>;
  }

  return (
    <details className="mt-2.5">
      <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]">
        Raw excerpt from file{" "}
        <span className="font-normal opacity-70">(verbatim)</span>
      </summary>
      <div className="mt-2">{inner}</div>
    </details>
  );
}

/** One human-facing line derived from summary or excerpt; avoids duplicating the claim. */
function pickEvidenceNarration(
  item: DiagnosisClaimReference,
  claimHeadline: string,
  claimFull: string
): { source: "summary" | "excerpt"; text: string } | null {
  const excerpt = item.excerpt?.trim() ?? "";
  const summary = item.summary?.trim() ?? "";

  if (
    summary &&
    !isSubstantiallyRedundant(summary, excerpt) &&
    !isSubstantiallyRedundant(summary, claimHeadline) &&
    !isSubstantiallyRedundant(summary, claimFull)
  ) {
    return { source: "summary", text: summary };
  }

  if (excerpt && !excerptIsLong(excerpt)) {
    const flat = excerpt.replace(/\s+/g, " ").trim();
    if (
      !isSubstantiallyRedundant(flat, claimHeadline) &&
      !isSubstantiallyRedundant(flat, claimFull) &&
      !isSubstantiallyRedundant(flat, summary)
    ) {
      return { source: "excerpt", text: flat };
    }
  }

  return null;
}

type RelevantContext = {
  kind: "trace" | "contradiction" | "missing";
  fullLabel: string;
  headline: string;
  /** One-line reasoning from the diagnosis trace—not raw log text. */
  rationale: string | null;
  refs: DiagnosisSnapshotViewModel["claimReferences"];
};

export function InspectPanel({
  evidence,
  diagnosis,
  selectedClaimKey,
  activeTab,
  onActiveTabChange,
}: InspectPanelProps) {
  const relevantContext = useMemo((): RelevantContext | null => {
    if (!diagnosis || !selectedClaimKey) {
      return null;
    }

    const traceMatch = diagnosis.trace.find((item) => item.claimKey === selectedClaimKey);

    if (traceMatch) {
      return {
        kind: "trace",
        fullLabel: traceMatch.claim,
        headline: claimHeadline(traceMatch.claim),
        rationale: isSubstantiallyRedundant(traceMatch.claim, traceMatch.evidence)
          ? null
          : traceMatch.evidence,
        refs: diagnosis.claimReferences.filter(
          (item) => item.claimKey === selectedClaimKey
        ),
      };
    }

    if (selectedClaimKey.startsWith("contradiction-")) {
      const index = Number(selectedClaimKey.split("-")[1] ?? -1);
      const label = diagnosis.contradictions[index] ?? null;

      if (!label) {
        return null;
      }

      return {
        kind: "contradiction",
        fullLabel: label,
        headline: claimHeadline(label),
        rationale:
          "Listed in the diagnosis as conflicting signals. Proof rows show what each side rests on.",
        refs: diagnosis.claimReferences.filter(
          (item) => item.claimKey === selectedClaimKey
        ),
      };
    }

    if (selectedClaimKey.startsWith("missing-")) {
      const index = Number(selectedClaimKey.split("-")[1] ?? -1);
      const label = diagnosis.missingEvidence[index] ?? null;

      if (!label) {
        return null;
      }

      return {
        kind: "missing",
        fullLabel: label,
        headline: claimHeadline(label),
        rationale:
          "Gap called out in the diagnosis. Adding this class of evidence usually tightens the next run.",
        refs: diagnosis.claimReferences.filter(
          (item) => item.claimKey === selectedClaimKey
        ),
      };
    }

    return null;
  }, [diagnosis, selectedClaimKey]);

  const issueGroups = useMemo(() => {
    const contradictions: { id: string; text: string }[] = [];
    const timing: { id: string; text: string }[] = [];
    const evidenceNotes: { id: string; text: string; file: string }[] = [];

    if (diagnosis) {
      diagnosis.contradictions.forEach((item, index) => {
        contradictions.push({ id: `contradiction-${index}`, text: item });
      });
    }

    const readyEvidence = evidence.filter(
      (item) => item.ingestStatus === "ready" || item.ingestStatus === "needs_review"
    );
    const withTimestamps = readyEvidence.filter((item) => {
      const timestamps =
        item.extracted && Array.isArray(item.extracted.timestamps)
          ? item.extracted.timestamps
          : [];
      return timestamps.length > 0;
    }).length;

    if (readyEvidence.length > 1 && withTimestamps > 0 && withTimestamps < readyEvidence.length) {
      timing.push({
        id: "timestamp-alignment",
        text: "Not every piece of evidence has timestamps, so timelines may not line up cleanly.",
      });
    }

    evidence.forEach((item) => {
      if (item.ingestStatus === "unsupported") {
        evidenceNotes.push({
          id: `${item.id}-unsupported`,
          text: "Format not supported for structured parsing.",
          file: item.originalName,
        });
      }
      if (item.secretsDetected) {
        evidenceNotes.push({
          id: `${item.id}-secret`,
          text: "Possible secret material—treat exports carefully.",
          file: item.originalName,
        });
      }
      for (const warning of item.parseWarnings) {
        evidenceNotes.push({
          id: `${item.id}-${warning}`,
          text: warning,
          file: item.originalName,
        });
      }
    });

    return { contradictions, timing, evidenceNotes };
  }, [diagnosis, evidence]);

  const totalIssues =
    issueGroups.contradictions.length +
    issueGroups.timing.length +
    issueGroups.evidenceNotes.length;

  const claimFocusKicker =
    relevantContext?.kind === "contradiction"
      ? "Conflicting signal"
      : relevantContext?.kind === "missing"
        ? "Evidence gap"
        : "Line from this read";

  const relationPillLabel: Record<ClaimReferenceRelationValue, string> = {
    supports: "Supports",
    weakens: "Weakens",
    unclear: "Unclear tie",
  };
  const diagnosisEvidenceVersion = diagnosis?.caseEvidenceVersion ?? null;
  const highlightedEvidenceIds = diagnosis
    ? diagnosis.claimReferences
        .flatMap((item) => (item.evidenceId ? [item.evidenceId] : []))
        .filter((value, index, all) => all.indexOf(value) === index)
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex gap-1 border-b border-[var(--color-border-subtle)]/55 pb-3"
        role="tablist"
        aria-label="Inspect panel"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab;

          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onActiveTabChange(tab)}
              className={cn(
                "min-h-9 rounded-[6px] px-3 py-1.5 text-[11px] font-semibold transition-colors duration-[var(--motion-base)]",
                isActive
                  ? "bg-[rgba(255,255,255,0.04)] text-[var(--color-text-secondary)]"
                  : "text-[var(--color-text-muted)] hover:bg-[rgba(255,255,255,0.025)] hover:text-[var(--color-text-secondary)]"
              )}
            >
              {TAB_LABELS[tab]}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pt-5 [scrollbar-gutter:stable]">
        {activeTab === "Relevant" ? (
          relevantContext ? (
            <div className="space-y-6">
              <div>
                <p className="text-[11px] font-medium tracking-[0.02em] text-[var(--color-text-muted)]">
                  {claimFocusKicker}
                </p>
                <p className="mt-1.5 text-[14px] font-medium leading-[21px] text-[var(--color-text-primary)]">
                  {relevantContext.headline}
                </p>
                {relevantContext.rationale ? (
                  <div className="mt-2.5">
                    {relevantContext.kind === "trace" ? (
                      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                        As stated in the read
                      </p>
                    ) : null}
                    <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                      {relevantContext.rationale}
                    </p>
                  </div>
                ) : null}
                {relevantContext.fullLabel !== relevantContext.headline ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]">
                      Original wording (full)
                    </summary>
                    <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(0,0,0,0.04)] p-2 font-mono text-[10px] leading-[15px] text-[var(--color-text-muted)]">
                      {relevantContext.fullLabel}
                    </pre>
                  </details>
                ) : null}
              </div>

              <div>
                <p className="text-[11px] font-medium tracking-[0.02em] text-[var(--color-text-muted)]">
                  How files connect
                </p>
                {relevantContext.refs.length > 0 ? (
                  <ul className="mt-3 list-none space-y-5 p-0">
                    {relevantContext.refs.map((item) => {
                      const rel = RELATION_PANEL[item.relation];
                      const narr = pickEvidenceNarration(
                        item,
                        relevantContext.headline,
                        relevantContext.fullLabel
                      );
                      const excerptNorm =
                        item.excerpt?.replace(/\s+/g, " ").trim() ?? "";
                      const narrIsFullShortExcerpt =
                        narr?.source === "excerpt" &&
                        narr.text === excerptNorm;
                      const showRaw =
                        Boolean(item.excerpt) && !narrIsFullShortExcerpt;

                      return (
                        <li
                          key={item.id}
                          className={cn("border-l-2 pl-3", rel.bar)}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.07em]",
                                rel.pill
                              )}
                            >
                              {relationPillLabel[item.relation]}
                            </span>
                            <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
                              {item.evidenceName ?? "Unnamed upload"}
                            </span>
                            {item.sourceLabel ? (
                              <>
                                <span
                                  className="text-[var(--color-text-muted)] opacity-50"
                                  aria-hidden
                                >
                                  ·
                                </span>
                                <span className="text-[11px] text-[var(--color-text-muted)]">
                                  {item.sourceLabel}
                                </span>
                              </>
                            ) : null}
                          </div>
                          <p className="mt-2 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                            {rel.bridge}
                          </p>
                          {narr ? (
                            <p className="mt-2 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                              <span className="text-[var(--color-text-muted)]">
                                {narr.source === "summary"
                                  ? "Targ note · "
                                  : "From file · "}
                              </span>
                              {narr.text}
                            </p>
                          ) : null}
                          {showRaw && item.excerpt ? (
                            <RawExcerptBlock text={item.excerpt} />
                          ) : null}
                          {!item.excerpt && !narr ? (
                            <p className="mt-2 text-[11px] leading-[16px] text-[var(--color-text-muted)]">
                              No excerpt stored for this link. Open the file
                              under Uploads.
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-2.5 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                    Nothing mapped at excerpt level for this selection—the read
                    may still lean on the full file set. Check Uploads.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                Select a claim first
              </p>
              <p className="mt-1 text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
                Use <span className="font-medium text-[var(--color-text-primary)]">Proof</span> on a diagnosis line to see which files support it, weaken it, or leave it unresolved.
              </p>
            </div>
          )
        ) : null}

        {activeTab === "Uploads" ? (
          evidence.length > 0 ? (
            <ul className="list-none space-y-0 p-0">
              {evidence.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-1.5 border-b border-[var(--color-border-subtle)] py-2.5 last:border-0"
                >
                  <span className="truncate text-[12px] font-medium text-[var(--color-text-secondary)]">
                    {item.originalName}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    <Chip className="min-h-[22px] px-2 py-0 text-[10px]">
                      {EVIDENCE_KIND_LABELS[item.kind]}
                    </Chip>
                    <Chip className="min-h-[22px] px-2 py-0 text-[10px]">
                      {EVIDENCE_INGEST_STATUS_LABELS[item.ingestStatus]}
                    </Chip>
                    {highlightedEvidenceIds.includes(item.id) ? (
                      <Chip tone="confidence" className="min-h-[22px] px-2 py-0 text-[10px]">
                        Used in diagnosis
                      </Chip>
                    ) : null}
                    {diagnosisEvidenceVersion !== null &&
                    item.caseEvidenceVersion > diagnosisEvidenceVersion ? (
                      <Chip tone="warning" className="min-h-[22px] px-2 py-0 text-[10px]">
                        New since diagnosis
                      </Chip>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
              No evidence yet. Add it from the case header, then run analysis.
            </p>
          )
        ) : null}

        {activeTab === "Issues" ? (
          totalIssues > 0 ? (
            <div className="space-y-6">
              {issueGroups.contradictions.length > 0 ? (
                <section>
                  <h3 className="text-[11px] font-medium tracking-[0.02em] text-[var(--color-text-muted)]">
                    Contradictions in the current read
                  </h3>
                  <ul className="mt-2 list-none space-y-2 p-0">
                    {issueGroups.contradictions.map((row) => (
                      <li
                        key={row.id}
                        className="border-l-2 border-[rgba(211,163,90,0.35)] pl-3 text-[12px] leading-[18px] text-[var(--color-text-secondary)]"
                      >
                        {row.text}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {issueGroups.timing.length > 0 ? (
                <section>
                  <h3 className="text-[11px] font-medium tracking-[0.02em] text-[var(--color-text-muted)]">
                    Timeline coverage gaps
                  </h3>
                  <ul className="mt-2 list-none space-y-2 p-0">
                    {issueGroups.timing.map((row) => (
                      <li
                        key={row.id}
                        className="border-l border-[var(--color-border-subtle)] pl-3 text-[12px] leading-[18px] text-[var(--color-text-secondary)]"
                      >
                        {row.text}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {issueGroups.evidenceNotes.length > 0 ? (
                <section>
                  <h3 className="text-[11px] font-medium tracking-[0.02em] text-[var(--color-text-muted)]">
                    Parse and hygiene flags
                  </h3>
                  <ul className="mt-2 list-none space-y-2.5 p-0">
                    {issueGroups.evidenceNotes.map((row) => (
                      <li
                        key={row.id}
                        className="border-l border-[var(--color-border-subtle)] pl-3"
                      >
                        <p className="text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                          {row.text}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                          {row.file}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : (
            <p className="text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
              No parser flags right now. That only means ingestion stayed quiet, not that the current read is exhaustive.
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}
