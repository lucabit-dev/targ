"use client";

import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils/cn";
import {
  deriveCaseDefaultsFromPlaybook,
  WORKSPACE_ANALYSIS_BIAS_OPTIONS,
  WORKSPACE_EVIDENCE_PROFILE_OPTIONS,
  WORKSPACE_OUTCOME_DESTINATION_OPTIONS,
  WORKSPACE_OUTPUT_STYLE_OPTIONS,
  WORKSPACE_PLAYBOOK_DEFAULTS,
  WORKSPACE_TEAM_PROFILE_OPTIONS,
  type WorkspaceAnalysisBias,
  type WorkspaceEvidenceProfile,
  type WorkspaceOutcomeDestination,
  type WorkspaceOutputStyle,
  type WorkspacePlaybook,
  type WorkspaceTeamProfile,
} from "@/lib/workspace/playbook";

type WorkspacePlaybookOnboardingProps = {
  workspaceId: string;
  onComplete: (playbook: WorkspacePlaybook) => void;
};

type StepId = "team" | "analysis" | "output" | "evidence" | "destination";

type StepDefinition = {
  id: StepId;
  title: string;
  body: string;
};

type StepOption = {
  id: string;
  label: string;
  body: string;
};

function optionsForStepId(stepId: StepId): StepOption[] {
  if (stepId === "team") {
    return WORKSPACE_TEAM_PROFILE_OPTIONS;
  }
  if (stepId === "analysis") {
    return WORKSPACE_ANALYSIS_BIAS_OPTIONS;
  }
  if (stepId === "output") {
    return WORKSPACE_OUTPUT_STYLE_OPTIONS;
  }
  if (stepId === "evidence") {
    return WORKSPACE_EVIDENCE_PROFILE_OPTIONS;
  }
  return WORKSPACE_OUTCOME_DESTINATION_OPTIONS;
}

function optionLabelForStep(stepId: StepId, optionId: string): string {
  return optionsForStepId(stepId).find((o) => o.id === optionId)?.label ?? optionId;
}

function mergeAnswersWithDefaults(answers: Partial<Record<StepId, string>>): WorkspacePlaybook {
  return {
    version: 1,
    teamProfile:
      (answers.team as WorkspaceTeamProfile | undefined) ??
      WORKSPACE_PLAYBOOK_DEFAULTS.teamProfile,
    analysisBias:
      (answers.analysis as WorkspaceAnalysisBias | undefined) ??
      WORKSPACE_PLAYBOOK_DEFAULTS.analysisBias,
    outputStyle:
      (answers.output as WorkspaceOutputStyle | undefined) ??
      WORKSPACE_PLAYBOOK_DEFAULTS.outputStyle,
    evidenceProfile:
      (answers.evidence as WorkspaceEvidenceProfile | undefined) ??
      WORKSPACE_PLAYBOOK_DEFAULTS.evidenceProfile,
    outcomeDestination:
      (answers.destination as WorkspaceOutcomeDestination | undefined) ??
      WORKSPACE_PLAYBOOK_DEFAULTS.outcomeDestination,
  };
}

const STEPS: StepDefinition[] = [
  {
    id: "team",
    title: "What kind of team is this workspace for?",
    body: "I’ll use this to choose which lens should lead when a case comes in.",
  },
  {
    id: "analysis",
    title: "How should I balance action and certainty?",
    body: "This sets the default posture for diagnosis and next-step recommendations.",
  },
  {
    id: "output",
    title: "What should a strong result feel like?",
    body: "I can keep the output task-first, diagnosis-first, or handoff-ready.",
  },
  {
    id: "evidence",
    title: "What kind of evidence usually comes in first?",
    body: "This helps me weigh logs, screenshots, notes, and mixed signals correctly.",
  },
  {
    id: "destination",
    title: "Where should the work go after the analysis?",
    body: "This shapes how explicit and transferable I make the task package.",
  },
];

function isCompletePlaybookAnswers(
  value: Partial<Record<StepId, string>>
): value is Record<StepId, string> {
  return STEPS.every((step) => value[step.id] != null && value[step.id] !== "");
}

function buildPlaybookFromAnswers(answers: Record<StepId, string>): WorkspacePlaybook {
  const team = answers.team as WorkspaceTeamProfile | undefined;
  const analysis = answers.analysis as WorkspaceAnalysisBias | undefined;
  const output = answers.output as WorkspaceOutputStyle | undefined;
  const evidence = answers.evidence as WorkspaceEvidenceProfile | undefined;
  const destination = answers.destination as WorkspaceOutcomeDestination | undefined;

  if (!team || !analysis || !output || !evidence || !destination) {
    throw new Error("Playbook answers are incomplete.");
  }

  return {
    version: 1,
    teamProfile: team,
    analysisBias: analysis,
    outputStyle: output,
    evidenceProfile: evidence,
    outcomeDestination: destination,
  };
}

function TargMessage({
  title,
  body,
  animated = false,
}: {
  title: string;
  body: string;
  animated?: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-3", animated && "targ-chat-bubble-enter")}>
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgba(95,168,166,0.1)] text-[var(--color-accent-primary)]">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="max-w-[min(100%,24rem)] rounded-[20px] bg-[rgba(255,255,255,0.03)] px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-accent-primary)]">
          Targ
        </p>
        <h2
          className={cn(
            "mt-1.5 text-[14px] font-semibold leading-[19px] tracking-[-0.02em] text-[var(--color-text-primary)]",
            animated && "targ-chat-text-enter"
          )}
        >
          {title}
        </h2>
        <p
          className={cn(
            "mt-1.5 text-[13px] leading-[20px] text-[var(--color-text-secondary)]",
            animated && "targ-chat-text-enter [animation-delay:100ms]"
          )}
        >
          {body}
        </p>
      </div>
    </div>
  );
}

function TargTypingBubble({
  title,
  body,
  active,
  animated = false,
  onTypingTick,
  onTypingComplete,
}: {
  title: string;
  body: string;
  active: boolean;
  animated?: boolean;
  onTypingTick?: () => void;
  onTypingComplete?: () => void;
}) {
  const [displayTitle, setDisplayTitle] = useState(() => (active ? "" : title));
  const [displayBody, setDisplayBody] = useState(() => (active ? "" : body));
  const [typingDone, setTypingDone] = useState(!active);
  const onTypingCompleteRef = useRef(onTypingComplete);
  // Keep the ref pointed at the latest callback without touching it during
  // render (which React 19 flags — refs are mutable state and must only be
  // written in effects or handlers).
  useEffect(() => {
    onTypingCompleteRef.current = onTypingComplete;
  }, [onTypingComplete]);

  /* This effect orchestrates a character-by-character typing animation via
   * `setTimeout`s. The state updates inside timer callbacks are unavoidable
   * — they ARE the animation. The up-front `setX("")` calls reset the
   * buffer when `active`/`title`/`body` change, which is prop-derived state
   * that genuinely belongs here (there's no render-time way to reset
   * animation progress when the source text changes).
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!active) {
      setDisplayTitle("");
      setDisplayBody("");
      setTypingDone(true);
      return;
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDisplayTitle(title);
      setDisplayBody(body);
      setTypingDone(true);
      window.queueMicrotask(() => {
        onTypingCompleteRef.current?.();
      });
      return;
    }

    setDisplayTitle("");
    setDisplayBody("");
    setTypingDone(false);

    const charMs = 14;
    const pauseMs = 72;
    const timeouts: number[] = [];
    let t = 0;

    for (let i = 1; i <= title.length; i++) {
      const snap = i;
      timeouts.push(
        window.setTimeout(() => {
          setDisplayTitle(title.slice(0, snap));
          onTypingTick?.();
        }, t)
      );
      t += charMs;
    }

    t += pauseMs;

    for (let i = 1; i <= body.length; i++) {
      const snap = i;
      timeouts.push(
        window.setTimeout(() => {
          setDisplayBody(body.slice(0, snap));
          onTypingTick?.();
          if (snap === body.length) {
            setTypingDone(true);
            onTypingCompleteRef.current?.();
          }
        }, t)
      );
      t += charMs;
    }

    if (body.length === 0) {
      timeouts.push(
        window.setTimeout(() => {
          setTypingDone(true);
          onTypingTick?.();
          onTypingCompleteRef.current?.();
        }, t)
      );
    }

    return () => {
      for (const id of timeouts) {
        window.clearTimeout(id);
      }
    };
  }, [active, title, body, onTypingTick]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const showCaret = active && !typingDone;

  return (
    <div className={cn("flex items-start gap-3", animated && "targ-chat-bubble-enter")}>
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgba(95,168,166,0.1)] text-[var(--color-accent-primary)]">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="max-w-[min(100%,24rem)] rounded-[20px] bg-[rgba(255,255,255,0.03)] px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-accent-primary)]">
          Targ
        </p>
        <h2 className="mt-1.5 text-[14px] font-semibold leading-[19px] tracking-[-0.02em] text-[var(--color-text-primary)]">
          {displayTitle}
          {showCaret && displayTitle.length < title.length ? (
            <span
              aria-hidden
              className="ml-0.5 inline-block h-[14px] w-px translate-y-[2px] bg-[var(--color-accent-primary)] align-middle motion-safe:animate-pulse"
            />
          ) : null}
        </h2>
        <p className="mt-1.5 min-h-[2.5rem] text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
          {displayBody}
          {showCaret && displayTitle.length >= title.length && displayBody.length < body.length ? (
            <span
              aria-hidden
              className="ml-0.5 inline-block h-[13px] w-px translate-y-[2px] bg-[var(--color-accent-primary)] align-middle motion-safe:animate-pulse"
            />
          ) : null}
        </p>
      </div>
    </div>
  );
}

function ThinkingMessage() {
  return (
    <div className="targ-chat-thinking-enter flex items-start gap-3">
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgba(95,168,166,0.1)] text-[var(--color-accent-primary)]">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="flex items-center gap-1.5 rounded-[20px] bg-[rgba(255,255,255,0.03)] px-4 py-3">
        <span className="targ-chat-thinking-dot" />
        <span className="targ-chat-thinking-dot [animation-delay:120ms]" />
        <span className="targ-chat-thinking-dot [animation-delay:240ms]" />
      </div>
    </div>
  );
}

function UserMessage({ answer }: { answer: string }) {
  return (
    <div className="targ-chat-answer-enter flex justify-end">
      <div className="max-w-[24rem] rounded-[20px] bg-[rgba(95,168,166,0.1)] px-4 py-3 text-[13px] leading-[20px] text-[var(--color-text-primary)]">
        {answer}
      </div>
    </div>
  );
}

function ReplyOption({
  active,
  label,
  body,
  onClick,
  animationDelayMs,
}: {
  active: boolean;
  label: string;
  body: string;
  onClick: () => void;
  animationDelayMs: number;
}) {
  return (
    <div
      className={cn("group relative z-10 min-w-0 overflow-visible targ-chat-replies-enter")}
      style={{ animationDelay: `${animationDelayMs}ms` }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label}. ${body}`}
        className={cn(
          "relative z-10 min-h-[28px] w-full max-w-full truncate rounded-md border px-1.5 py-1 text-center text-[11px] font-medium leading-[14px] tracking-[-0.02em] transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,168,166,0.28)] sm:min-h-[30px] sm:px-2 sm:py-1 sm:text-[12px] sm:leading-4",
          active
            ? "border-[rgba(95,168,166,0.35)] bg-[rgba(95,168,166,0.12)] text-[var(--color-text-primary)] shadow-[inset_0_0_0_1px_rgba(95,168,166,0.06)]"
            : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[var(--color-text-secondary)] hover:border-[rgba(95,168,166,0.24)] hover:bg-[rgba(255,255,255,0.05)] hover:text-[var(--color-text-primary)]"
        )}
      >
        <span className="block truncate">{label}</span>
      </button>
      <div
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-0 right-0 top-full z-[80] mt-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] bg-[var(--color-surface-2)] px-2.5 py-2 text-left text-[11px] leading-[16px] text-[var(--color-text-secondary)] shadow-[0_14px_40px_rgba(0,0,0,0.45)]",
          "max-h-[min(12rem,45vh)] overflow-y-auto overscroll-contain whitespace-normal break-words [overflow-wrap:anywhere]",
          "invisible translate-y-0.5 opacity-0 transition-[opacity,transform,visibility] duration-[var(--motion-fast)]",
          "group-hover:visible group-hover:translate-y-0 group-hover:opacity-100",
          "group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
        )}
      >
        {body}
      </div>
    </div>
  );
}

function progressLabel(currentStepIndex: number) {
  return `${currentStepIndex + 1} / ${STEPS.length}`;
}

export function WorkspacePlaybookOnboarding({
  workspaceId,
  onComplete,
}: WorkspacePlaybookOnboardingProps) {
  const [answers, setAnswers] = useState<Partial<Record<StepId, string>>>({});
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [currentMessageVisible, setCurrentMessageVisible] = useState(false);
  const [isThinking, setIsThinking] = useState(true);
  const [replyStageVisible, setReplyStageVisible] = useState(false);
  const [introTypingComplete, setIntroTypingComplete] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const advanceTimeoutRef = useRef<number | null>(null);

  const revealRepliesAfterTyping = useCallback(() => {
    setReplyStageVisible(true);
  }, []);

  const onIntroTypingComplete = useCallback(() => {
    setIntroTypingComplete(true);
  }, []);

  const scrollMessagesToEnd = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }

    window.requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior });
    });
  }, []);

  const scrollMessagesDuringTyping = useCallback(() => {
    scrollMessagesToEnd("auto");
  }, [scrollMessagesToEnd]);

  const currentStep = STEPS[currentStepIndex];
  const previewPlaybook = useMemo(() => mergeAnswersWithDefaults(answers), [answers]);
  const caseDefaults = deriveCaseDefaultsFromPlaybook(previewPlaybook);

  const summaryLine = useMemo(() => {
    const dash = (stepId: StepId) => {
      const value = answers[stepId];
      return value ? optionLabelForStep(stepId, value) : "—";
    };

    return `${dash("team")} · ${dash("analysis")} · ${dash("output")} · ${dash("evidence")} · ${dash("destination")}`;
  }, [answers]);

  const answeredSteps = useMemo(() => {
    return STEPS.slice(0, currentStepIndex).map((step) => {
      const id = answers[step.id];
      return {
        id: step.id,
        question: step.title,
        body: step.body,
        answer: id ? optionLabelForStep(step.id, id) : "—",
      };
    });
  }, [currentStepIndex, answers]);

  const currentOptions = useMemo(() => optionsForStepId(currentStep.id), [currentStep.id]);

  useEffect(() => {
    if (!introTypingComplete) {
      return;
    }

    setCurrentMessageVisible(false);
    setIsThinking(true);
    setReplyStageVisible(false);
    const thinkingTimer = window.setTimeout(() => {
      setIsThinking(false);
      setCurrentMessageVisible(true);
    }, 420);

    return () => {
      window.clearTimeout(thinkingTimer);
    };
  }, [currentStepIndex, introTypingComplete]);

  useEffect(() => {
    scrollMessagesToEnd("smooth");
  }, [
    answeredSteps.length,
    currentStepIndex,
    currentMessageVisible,
    introTypingComplete,
    replyStageVisible,
    scrollMessagesToEnd,
  ]);

  useEffect(() => {
    return () => {
      if (advanceTimeoutRef.current !== null) {
        window.clearTimeout(advanceTimeoutRef.current);
      }
    };
  }, []);

  function isOptionSelected(optionId: string) {
    const chosen = answers[currentStep.id];
    return chosen != null && chosen !== "" && chosen === optionId;
  }

  function updateCurrentStepSelection(optionId: string) {
    setError(null);

    setAnswers((prev) => {
      const next: Partial<Record<StepId, string>> = { ...prev, [currentStep.id]: optionId };
      for (let j = currentStepIndex + 1; j < STEPS.length; j++) {
        delete next[STEPS[j].id];
      }
      return next;
    });

    if (currentStepIndex < STEPS.length - 1) {
      if (advanceTimeoutRef.current !== null) {
        window.clearTimeout(advanceTimeoutRef.current);
      }
      advanceTimeoutRef.current = window.setTimeout(() => {
        setCurrentStepIndex((current) => Math.min(STEPS.length - 1, current + 1));
      }, 260);
    }
  }

  function goBack() {
    if (advanceTimeoutRef.current !== null) {
      window.clearTimeout(advanceTimeoutRef.current);
    }
    setCurrentStepIndex((current) => Math.max(0, current - 1));
  }

  async function savePlaybook(nextPlaybook: WorkspacePlaybook) {
    setError(null);
    setIsSaving(true);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/playbook`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(nextPlaybook),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
        setError(data?.error ?? "Could not save workspace playbook.");
        return;
      }

      onComplete(nextPlaybook);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setIsSaving(false);
    }
  }

  const defaultsLine = `${caseDefaults.solveMode.replace(/_/g, " ")} · ${(caseDefaults.problemLens ?? "auto").replace(/_/g, " ")}`;

  const allStepsAnswered = STEPS.every(
    (step) => answers[step.id] != null && answers[step.id] !== ""
  );

  return (
    <div className="targ-home-shell-enter flex h-full min-h-0 w-full max-w-[48rem] flex-1 flex-col self-center px-1">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[rgba(255,255,255,0.06)] px-1 py-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent-primary)]">
            Targ setup
          </p>
          <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-muted)]">
            {progressLabel(currentStepIndex)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void savePlaybook(WORKSPACE_PLAYBOOK_DEFAULTS)}
          className="text-[12px] font-medium text-[var(--color-text-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-text-secondary)]"
        >
          Use recommended
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            ref={messagesRef}
            className="targ-playbook-onboarding-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-3 pr-2"
          >
            <div className="space-y-4">
              <TargTypingBubble
                title="Let’s set how I should work in this workspace."
                body="Answer step by step and I’ll keep the defaults lightweight. You can still override them later inside any case."
                active
                animated
                onTypingTick={scrollMessagesDuringTyping}
                onTypingComplete={onIntroTypingComplete}
              />

              {answeredSteps.map((step) => (
                <div key={step.id} className="space-y-3">
                  <TargMessage title={step.question} body={step.body} />
                  <UserMessage answer={step.answer} />
                </div>
              ))}

              {introTypingComplete ? (
                <div key={currentStep.id} className="space-y-3">
                  {isThinking ? <ThinkingMessage /> : null}
                  {currentMessageVisible ? (
                    <TargTypingBubble
                      title={currentStep.title}
                      body={currentStep.body}
                      active
                      animated
                      onTypingTick={scrollMessagesDuringTyping}
                      onTypingComplete={revealRepliesAfterTyping}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="relative z-20 flex shrink-0 flex-col gap-2 overflow-visible border-t border-[rgba(255,255,255,0.06)] px-1 py-2.5">
          {replyStageVisible ? (
            <div
              key={`${currentStep.id}-replies`}
              className={cn(
                "grid w-full gap-1 overflow-visible sm:gap-1.5",
                currentOptions.length <= 3 ? "grid-cols-3" : "grid-cols-2"
              )}
            >
              {currentOptions.map((option, index) => (
                <ReplyOption
                  key={option.id}
                  active={isOptionSelected(option.id)}
                  label={option.label}
                  body={option.body}
                  onClick={() => updateCurrentStepSelection(option.id)}
                  animationDelayMs={index * 40}
                />
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-[rgba(255,255,255,0.06)] pt-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                Current defaults
              </p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-[16px] text-[var(--color-text-secondary)] sm:text-[12px] sm:leading-[18px]">
                {summaryLine}
              </p>
              <p className="mt-1 line-clamp-1 text-[10px] leading-[14px] text-[var(--color-text-muted)]">
                Inferred case defaults: {defaultsLine}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
              <Button
                variant="tertiary"
                onClick={goBack}
                disabled={currentStepIndex === 0 || isSaving}
                className="px-3"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              {currentStepIndex === STEPS.length - 1 ? (
                <Button
                  onClick={() => {
                    if (!isCompletePlaybookAnswers(answers)) {
                      setError("Choose an option for each step before finishing.");
                      return;
                    }
                    void savePlaybook(buildPlaybookFromAnswers(answers));
                  }}
                  disabled={isSaving || !allStepsAnswered}
                  className="gap-2 px-4"
                >
                  {isSaving ? "Saving…" : "Finish setup"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <div className="rounded-full bg-[rgba(255,255,255,0.025)] px-2.5 py-1 text-[11px] leading-4 text-[var(--color-text-muted)]">
                  Choose one
                </div>
              )}
            </div>
          </div>

          {error ? <div className="targ-callout-critical mt-2 py-2 text-xs leading-snug">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
