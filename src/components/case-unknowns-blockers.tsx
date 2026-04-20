"use client";

import { Button } from "@/components/ui/primitives";

type CaseUnknownsBlockersProps = {
  pendingQuestion: string;
  pendingOptions: string[];
  questionCount: number;
  isAnswering: boolean;
  onSelectOption: (option: string) => void;
  onOpenEvidenceWorkspace: () => void;
};

export function CaseUnknownsBlockers({
  pendingQuestion,
  pendingOptions,
  questionCount,
  isAnswering,
  onSelectOption,
  onOpenEvidenceWorkspace,
}: CaseUnknownsBlockersProps) {
  const roundHint =
    questionCount >= 2
      ? "Last round—then the read closes from what you've given."
      : "First clarification round—you may get one more if the read still can't decide.";

  return (
    <section
      className="scroll-mt-6 max-lg:scroll-mt-28 border-l border-[rgba(211,163,90,0.4)] pl-3.5 sm:pl-4"
      aria-labelledby="unknowns-blockers-heading"
    >
      <h2
        id="unknowns-blockers-heading"
        className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]"
      >
        Unknowns & blockers
      </h2>

      <p className="mt-1.5 text-[13px] font-semibold leading-[20px] text-[var(--color-text-primary)]">
        {pendingQuestion}
      </p>

      <p className="mt-1.5 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
        Pick the closest answer to unblock the plan—or add evidence, then
        re-run from the header. {roundHint}
      </p>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {pendingOptions.map((option) => (
          <Button
            key={option}
            variant="secondary"
            disabled={isAnswering}
            onClick={() => onSelectOption(option)}
            className="min-h-8 rounded-[var(--radius-sm)] px-2.5 py-0 text-[12px] font-semibold"
          >
            {option}
          </Button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          variant="tertiary"
          type="button"
          onClick={onOpenEvidenceWorkspace}
          className="min-h-8 px-2 text-[12px] font-semibold"
        >
          Evidence & inventory
        </Button>
      </div>
    </section>
  );
}
