"use client";

import { ArrowRight, Compass, Files, MessageSquare, Sparkles } from "lucide-react";
import { useState } from "react";

import { Button, Surface } from "@/components/ui/primitives";
import { cn } from "@/lib/utils/cn";

type HomeOnboardingProps = {
  onStart: () => void;
};

const ONBOARDING_STEPS = [
  {
    id: "prompt",
    label: "Signal first",
    title: "Start with the problem, not the setup",
    body:
      "Write the failure in plain language. Targ uses that signal to anchor everything that comes next.",
    previewTitle: "Describe what needs work",
    previewBody:
      "Production checkout returns 500 after the latest deploy. Logs point at payment retries but the UI screenshot suggests a stalled state.",
    icon: MessageSquare,
  },
  {
    id: "files",
    label: "Add proof",
    title: "Attach evidence only after the prompt is clear",
    body:
      "Bring in logs, screenshots, or notes when they sharpen the case. Skip this part when you're still collecting proof.",
    previewTitle: "Drop files or continue without them",
    previewBody: "checkout-timeout.log · payments-trace.json · frozen-state.png",
    icon: Files,
  },
  {
    id: "direction",
    label: "Shape the read",
    title: "Choose the depth and angle last",
    body:
      "Resolution style and perspective stay out of the way until the case itself is clear.",
    previewTitle: "Pick how far to take the plan",
    previewBody: "Proper fix · Auto perspective",
    icon: Compass,
  },
] as const;

export function HomeOnboarding({ onStart }: HomeOnboardingProps) {
  const [activeStep, setActiveStep] = useState(0);
  const currentStep = ONBOARDING_STEPS[activeStep];
  const CurrentIcon = currentStep.icon;

  return (
    <div className="targ-home-shell-enter relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[30px] border border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,#15191d_0%,#101214_100%)] shadow-[0_32px_90px_rgba(0,0,0,0.3)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(95,168,166,0.18),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.03),transparent_48%)]"
      />

      <div className="relative flex min-h-0 flex-1 flex-col justify-between px-6 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-10">
        <div className="targ-home-shell-enter flex items-center justify-between gap-3 [animation-delay:30ms]">
          <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">
            <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent-primary)]" />
            First-time flow
          </div>
          <button
            type="button"
            onClick={onStart}
            className="text-[12px] font-medium text-[var(--color-text-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-text-secondary)]"
          >
            Skip
          </button>
        </div>

        <div className="grid min-h-0 flex-1 items-center gap-10 overflow-y-auto py-8 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)] lg:gap-14">
          <div className="targ-home-shell-enter max-w-[40rem] [animation-delay:80ms]">
            <p className="targ-eyebrow text-[var(--color-accent-primary)]">
              Turn a problem into work
            </p>
            <h1 className="mt-3 text-[clamp(2.7rem,5vw,5rem)] font-semibold leading-[0.92] tracking-[-0.065em] text-[var(--color-text-primary)]">
              A lighter way to open a case.
            </h1>
            <p className="mt-5 max-w-[32rem] text-[15px] leading-[24px] text-[var(--color-text-secondary)] sm:text-[16px]">
              Inspired by chat-first tools, but built for grounded investigation: one input at a
              time, just enough guidance, and no crowded setup screen.
            </p>

            <div className="mt-8 space-y-2.5">
              {ONBOARDING_STEPS.map((step, index) => {
                const StepIcon = step.icon;
                const active = index === activeStep;

                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => setActiveStep(index)}
                    className={cn(
                      "targ-home-chip-enter flex w-full items-start gap-3 rounded-[18px] border px-4 py-3 text-left transition-[border-color,background-color] duration-[var(--motion-base)]",
                      active
                        ? "border-[rgba(95,168,166,0.34)] bg-[rgba(95,168,166,0.1)]"
                        : "border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.02)] hover:border-[rgba(255,255,255,0.12)] hover:bg-[rgba(255,255,255,0.04)]"
                    )}
                    style={{ animationDelay: `${120 + index * 45}ms` }}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                        active
                          ? "border-[rgba(95,168,166,0.3)] bg-[rgba(95,168,166,0.15)] text-[var(--color-text-primary)]"
                          : "border-[rgba(255,255,255,0.08)] bg-[rgba(0,0,0,0.18)] text-[var(--color-text-muted)]"
                      )}
                    >
                      <StepIcon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                        {step.label}
                      </p>
                      <p className="mt-1 text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
                        {step.title}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <Surface
            tone="overlay"
            className="targ-home-shell-enter relative overflow-hidden rounded-[28px] border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.02))] p-5 [animation-delay:140ms] sm:p-6"
          >
            <div key={currentStep.id} className="targ-home-stage-enter">
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(95,168,166,0.5),transparent)]"
              />
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                <CurrentIcon className="h-3.5 w-3.5 text-[var(--color-accent-primary)]" />
                {currentStep.label}
              </div>
              <h2 className="mt-4 text-[26px] font-semibold leading-[1.02] tracking-[-0.05em] text-[var(--color-text-primary)]">
                {currentStep.title}
              </h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--color-text-secondary)]">
                {currentStep.body}
              </p>

              <div className="mt-8 rounded-[24px] border border-[rgba(255,255,255,0.08)] bg-[rgba(10,12,14,0.45)] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                    Step {activeStep + 1}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {ONBOARDING_STEPS.map((step, index) => (
                      <span
                        key={`${step.id}-dot`}
                        className={cn(
                          "h-1.5 rounded-full transition-all duration-[var(--motion-base)]",
                          index === activeStep
                            ? "w-8 bg-[var(--color-accent-primary)]"
                            : "w-1.5 bg-[rgba(255,255,255,0.18)]"
                        )}
                      />
                    ))}
                  </div>
                </div>
                <div className="rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.03)] px-4 py-4">
                  <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                    {currentStep.previewTitle}
                  </p>
                  <p className="mt-3 text-[14px] leading-[22px] text-[var(--color-text-primary)]">
                    {currentStep.previewBody}
                  </p>
                </div>
              </div>
            </div>
          </Surface>
        </div>

        <div className="targ-home-shell-enter flex flex-col gap-3 [animation-delay:180ms] sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] leading-[19px] text-[var(--color-text-muted)]">
            This intro only appears on first visit. After that, Home opens straight into the case composer.
          </p>
          <Button onClick={onStart} className="gap-2 self-start sm:self-auto">
            Start a case
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
