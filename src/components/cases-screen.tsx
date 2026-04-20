"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";

import { CasesList, type CaseListItem } from "@/components/cases-list";
import { Chip, Surface } from "@/components/ui/primitives";
import {
  CASE_LIST_CONFIDENCE_FILTER_LABEL,
  CASE_LIST_STATUS_FILTERS,
  caseInvestigationTriageRank,
  getCaseListNextUpHint,
  matchesCaseListStatusFilter,
  sortCasesByInvestigationTriage,
  type CaseListStatusFilterId,
} from "@/lib/case-list-status";
import { cn } from "@/lib/utils/cn";

type CasesScreenProps = {
  cases: CaseListItem[];
};

const NEXT_UP_MAX_RANK = 4;

export function CasesScreen({ cases }: CasesScreenProps) {
  const [statusFilter, setStatusFilter] =
    useState<CaseListStatusFilterId>("all");
  const [confidenceFilter, setConfidenceFilter] = useState("all");
  const [resultsViewportHeight, setResultsViewportHeight] = useState<number | null>(null);
  const [resultsMotionKey, setResultsMotionKey] = useState(0);
  const resultsViewportRef = useRef<HTMLDivElement | null>(null);
  const resultsMeasureRef = useRef<HTMLDivElement | null>(null);

  const confidenceScopedCases = useMemo(() => {
    return cases.filter((currentCase) => {
      if (confidenceFilter === "all") {
        return true;
      }

      return (currentCase.confidence ?? "").toLowerCase() === confidenceFilter;
    });
  }, [cases, confidenceFilter]);

  const filterCounts = useMemo(() => {
    return CASE_LIST_STATUS_FILTERS.reduce(
      (acc, filter) => {
        acc[filter.id] = confidenceScopedCases.filter((currentCase) =>
          matchesCaseListStatusFilter(currentCase, filter.id)
        ).length;
        return acc;
      },
      {} as Record<CaseListStatusFilterId, number>
    );
  }, [confidenceScopedCases]);

  const filteredCases = useMemo(() => {
    return confidenceScopedCases.filter((currentCase) =>
      matchesCaseListStatusFilter(currentCase, statusFilter)
    );
  }, [confidenceScopedCases, statusFilter]);

  const sortedCases = useMemo(
    () => sortCasesByInvestigationTriage(filteredCases),
    [filteredCases]
  );

  const nextCaseId = useMemo(() => {
    const first = sortedCases[0];
    if (!first) {
      return null;
    }
    return caseInvestigationTriageRank(first) <= NEXT_UP_MAX_RANK
      ? first.id
      : null;
  }, [sortedCases]);

  const nextCase = useMemo(
    () => sortedCases.find((currentCase) => currentCase.id === nextCaseId) ?? null,
    [nextCaseId, sortedCases]
  );

  const hasAnyCases = cases.length > 0;
  useLayoutEffect(() => {
    if (resultsViewportHeight === null) {
      return;
    }

    const nextHeight = resultsMeasureRef.current?.offsetHeight;
    const frame = window.requestAnimationFrame(() => {
      setResultsViewportHeight(nextHeight ?? null);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [resultsMotionKey, resultsViewportHeight]);

  function freezeResultsViewport() {
    const currentHeight = resultsViewportRef.current?.offsetHeight;
    if (currentHeight && Number.isFinite(currentHeight)) {
      setResultsViewportHeight(currentHeight);
    }
  }

  function handleStatusFilterChange(nextFilter: CaseListStatusFilterId) {
    if (nextFilter === statusFilter) {
      return;
    }

    freezeResultsViewport();
    setStatusFilter(nextFilter);
    setResultsMotionKey((current) => current + 1);
  }

  function handleConfidenceFilterChange(nextFilter: string) {
    if (nextFilter === confidenceFilter) {
      return;
    }

    freezeResultsViewport();
    setConfidenceFilter(nextFilter);
    setResultsMotionKey((current) => current + 1);
  }

  return (
    <div className="mx-auto w-full max-w-[44rem] lg:max-w-[50rem] xl:max-w-[56rem]">
      <header className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="targ-micro font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Cases
          </p>
          <h1 className="mt-1 text-[24px] font-semibold leading-[28px] tracking-[-0.04em] text-[var(--color-text-primary)] sm:text-[26px] sm:leading-[30px]">
            Open what needs you
          </h1>
          <p className="mt-1.5 max-w-[32rem] text-[13px] leading-[19px] text-[var(--color-text-secondary)]">
            A calm queue for active work, replies, and ready reads.
          </p>
        </div>
        <Link
          href="/"
          className="targ-btn targ-btn-primary shrink-0 px-4 py-2 text-[13px] font-semibold leading-4"
        >
          New case
        </Link>
      </header>

      <Surface
        tone="raised"
        padding="none"
        className="mb-3 min-h-[6.75rem] rounded-[20px] border-[rgba(95,168,166,0.14)] bg-[linear-gradient(180deg,rgba(20,29,30,0.92),rgba(20,23,26,0.92))] px-4 py-3.5 shadow-[0_16px_38px_rgba(0,0,0,0.16)] sm:mb-4 sm:px-5"
      >
        <div
          key={`next-${resultsMotionKey}`}
          className="targ-home-stage-enter flex min-h-[inherit] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          {nextCase ? (
            <>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip className="border-[rgba(95,168,166,0.18)] bg-[rgba(95,168,166,0.1)] text-[var(--color-accent-primary)]">
                    Next up
                  </Chip>
                  <span className="text-[12px] leading-[18px] text-[var(--color-text-muted)]">
                    {nextCase.statusLabel ?? "Active"}
                  </span>
                </div>
                <h2 className="mt-2 line-clamp-1 text-[15px] font-semibold leading-[20px] tracking-[-0.02em] text-[var(--color-text-primary)] sm:text-[16px] sm:leading-[21px]">
                  {nextCase.title}
                </h2>
                <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                  {getCaseListNextUpHint(nextCase)}
                </p>
              </div>
              <Link
                href={`/cases/${nextCase.id}`}
                className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text-primary)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-accent-primary)]"
              >
                Open case
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </>
          ) : (
            <div className="flex min-h-[inherit] flex-col justify-center">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                Next up
              </span>
              <p className="mt-1.5 text-[13px] leading-[19px] text-[var(--color-text-secondary)]">
                No suggested case in this view. Broaden the filters or start a new case.
              </p>
            </div>
          )}
        </div>
      </Surface>

      <div
        className="mb-3 rounded-[18px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] p-2 sm:mb-4"
        role="search"
        aria-label="Filter cases"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div
            className="flex min-w-0 flex-wrap gap-1"
            role="group"
            aria-label="Filter by case status"
          >
            {CASE_LIST_STATUS_FILTERS.map((filter) => {
              const active = statusFilter === filter.id;
              return (
                <button
                key={filter.id}
                type="button"
                onClick={() => handleStatusFilterChange(filter.id)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full px-3 py-2 text-[12px] font-medium leading-4 transition-[background-color,color,border-color] duration-[var(--motion-fast)]",
                  active
                      ? "bg-[rgba(255,255,255,0.075)] text-[var(--color-text-primary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
                      : "text-[var(--color-text-muted)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[var(--color-text-secondary)]"
                  )}
                >
                  <span>{filter.label}</span>
                  <span
                    className={cn(
                      "tabular-nums text-[11px]",
                      active
                        ? "text-[var(--color-text-secondary)]"
                        : "text-[var(--color-text-muted)]"
                    )}
                  >
                    {filterCounts[filter.id]}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="relative w-full shrink-0 sm:w-[10.5rem]">
            <label htmlFor="cases-confidence" className="sr-only">
              Filter by confidence
            </label>
            <select
              id="cases-confidence"
              value={confidenceFilter}
              onChange={(event) => handleConfidenceFilterChange(event.target.value)}
              aria-label="Filter by confidence"
              className="targ-select min-h-[38px] appearance-none rounded-full border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 pr-9 text-[12px] text-[var(--color-text-secondary)] focus:text-[var(--color-text-primary)]"
            >
              <option value="all">
                Certainty: {CASE_LIST_CONFIDENCE_FILTER_LABEL.all}
              </option>
              <option value="likely">
                Certainty: {CASE_LIST_CONFIDENCE_FILTER_LABEL.likely}
              </option>
              <option value="plausible">
                Certainty: {CASE_LIST_CONFIDENCE_FILTER_LABEL.plausible}
              </option>
              <option value="unclear">
                Certainty: {CASE_LIST_CONFIDENCE_FILTER_LABEL.unclear}
              </option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
          </div>
        </div>
      </div>

      <div
        ref={resultsViewportRef}
        className="min-h-[16rem] overflow-hidden transition-[height] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={resultsViewportHeight !== null ? { height: `${resultsViewportHeight}px` } : undefined}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget || event.propertyName !== "height") {
            return;
          }

          const nextHeight = resultsMeasureRef.current?.offsetHeight;
          if (!nextHeight) {
            setResultsViewportHeight(null);
            return;
          }

          setResultsViewportHeight((current) => {
            if (current === null) {
              return current;
            }

            return Math.abs(current - nextHeight) <= 1 ? null : current;
          });
        }}
      >
        <div
          ref={resultsMeasureRef}
          key={`results-${resultsMotionKey}`}
          className="targ-home-stage-enter"
        >
          {hasAnyCases && filteredCases.length === 0 ? (
            <Surface
              tone="raised"
              padding="none"
              className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-5 py-8 text-center sm:px-8 sm:py-9"
            >
              <div className="targ-section-title text-[var(--color-text-primary)]">
                Nothing matches
              </div>
              <p className="mx-auto mt-2 max-w-sm targ-body text-[var(--color-text-secondary)]">
                Loosen status or set certainty to Any. Nothing in this workspace
                matches both filters right now.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <Chip>
                  {CASE_LIST_STATUS_FILTERS.find(
                    (filter) => filter.id === statusFilter
                  )?.label}
                </Chip>
                {confidenceFilter !== "all" ? (
                  <Chip tone="confidence">
                    {CASE_LIST_CONFIDENCE_FILTER_LABEL[confidenceFilter] ??
                      confidenceFilter}
                  </Chip>
                ) : null}
              </div>
            </Surface>
          ) : (
            <CasesList
              cases={sortedCases}
              nextCaseId={nextCaseId}
              emptyTitle="No cases yet"
              emptyBody="From Home: describe the issue and attach what you have. First case opens in one step."
              motionKey={resultsMotionKey}
            />
          )}
        </div>
      </div>
    </div>
  );
}
