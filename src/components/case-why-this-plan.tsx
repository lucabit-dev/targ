"use client";

import { Button } from "@/components/ui/primitives";
import type {
  ActionDraftViewModel,
  DiagnosisSnapshotViewModel,
} from "@/lib/analysis/view-model";
import {
  buildAlternatives,
  buildContradictionTeasers,
  buildTraceClusters,
  confidenceCeilingBase,
  whyPlanRationale,
} from "@/lib/analysis/why-this-plan";

type CaseWhyThisPlanProps = {
  diagnosis: DiagnosisSnapshotViewModel;
  draft: ActionDraftViewModel | null;
  onOpenProof: (claimKey: string) => void;
  onOpenInspectUploads: () => void;
};

export function CaseWhyThisPlan({
  diagnosis,
  draft,
  onOpenProof,
  onOpenInspectUploads,
}: CaseWhyThisPlanProps) {
  const rationale = whyPlanRationale(diagnosis, draft);
  const alternatives = buildAlternatives(diagnosis);
  const clusters = buildTraceClusters(diagnosis);
  const ceiling = confidenceCeilingBase(diagnosis);
  const tensionLines = buildContradictionTeasers(diagnosis, 2);
  const moreTensions = diagnosis.contradictions.length - tensionLines.length;
  const shouldOpenByDefault =
    diagnosis.confidence === "unclear" || diagnosis.contradictions.length > 0;

  return (
    <section
      id="case-why-this-plan"
      className="scroll-mt-8 max-lg:scroll-mt-[7.5rem]"
      aria-labelledby="why-this-plan-heading"
    >
      <details
        open={shouldOpenByDefault}
        className="group rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/70 bg-[rgba(255,255,255,0.015)] px-3 py-3"
      >
        <summary className="flex cursor-pointer list-none flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
          <div>
            <h2
              id="why-this-plan-heading"
              className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]"
            >
              Reasoning
            </h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
              {rationale}
            </p>
          </div>
          <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
            {shouldOpenByDefault ? "Open" : "Details"}
          </span>
        </summary>

        <div className="mt-3 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                Confidence and limits
              </h3>
              <p className="mt-1 max-w-2xl text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                {ceiling}
              </p>
            </div>
            <Button
              variant="tertiary"
              type="button"
              onClick={onOpenInspectUploads}
              className="shrink-0 self-start rounded-[var(--radius-sm)] px-2 py-1 text-[11px] font-semibold sm:self-auto"
            >
              Files & proof
            </Button>
          </div>

          {tensionLines.length > 0 ? (
            <div>
              <p className="text-[11px] font-semibold text-[var(--color-text-primary)]">
                Biggest tensions to resolve
              </p>
              <ul className="mt-1 list-none space-y-1.5 p-0">
                {tensionLines.map((line, index) => (
                  <li
                    key={`${index}-${line.slice(0, 24)}`}
                    className="flex items-start justify-between gap-2"
                  >
                    <span className="min-w-0 text-[12px] leading-[18px] text-[var(--color-state-warning)]">
                      {line}
                    </span>
                    <Button
                      variant="tertiary"
                      type="button"
                      onClick={() => onOpenProof(`contradiction-${index}`)}
                      className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold"
                    >
                      Proof
                    </Button>
                  </li>
                ))}
              </ul>
              {moreTensions > 0 ? (
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  +{moreTensions} more in Files & proof.
                </p>
              ) : null}
            </div>
          ) : null}

          {(alternatives.length > 1 || clusters.length > 0) ? (
            <details>
              <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]">
                More reasoning
              </summary>
              <div className="mt-3 space-y-3">
                {alternatives.length > 1 ? (
                  <div>
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                      Alternatives still in play
                    </h3>
                    <ul className="mt-1.5 list-none space-y-2 p-0">
                      {alternatives.map((alt) => (
                        <li key={alt.title} className="space-y-0.5">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
                            <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">
                              {alt.title}
                            </span>
                            <span className="text-[10px] font-medium uppercase tracking-[0.04em] text-[var(--color-text-muted)]">
                              {alt.confidenceLabel}
                            </span>
                          </div>
                          <p className="text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                            {alt.reasoning}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {clusters.length > 0 ? (
                  <div>
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                      Claim lines behind this path
                    </h3>
                    <div className="mt-2 space-y-3">
                      {clusters.map((cluster) => (
                        <div key={cluster.id}>
                          <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                            {cluster.label}
                          </p>
                          <ul className="mt-1 list-none space-y-1.5 p-0">
                            {cluster.items.map((item) => (
                              <li
                                key={item.claimKey}
                                className="flex items-start justify-between gap-2"
                              >
                                <span className="min-w-0 text-[12px] leading-[18px] text-[var(--color-text-primary)]">
                                  {item.claim}
                                </span>
                                <Button
                                  variant="tertiary"
                                  type="button"
                                  onClick={() => onOpenProof(item.claimKey)}
                                  className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold"
                                >
                                  Proof
                                </Button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </details>
    </section>
  );
}
