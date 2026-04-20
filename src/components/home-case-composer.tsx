"use client";

import { ArrowLeft, ArrowRight, Files, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppShellChrome } from "@/components/app-shell";
import { HomeOnboarding } from "@/components/home-onboarding";
import { WorkspacePlaybookOnboarding } from "@/components/workspace-playbook-onboarding";
import { Button, Surface } from "@/components/ui/primitives";
import type {
  CaseProblemLensValue,
  CaseSolveModeValue,
} from "@/lib/planning/intake-preferences";
import { cn } from "@/lib/utils/cn";
import {
  deriveCaseDefaultsFromPlaybook,
  type WorkspacePlaybook,
} from "@/lib/workspace/playbook";

type HomeCaseComposerProps = {
  workspaceId: string;
  initialWorkspacePlaybook: WorkspacePlaybook | null;
};

type FlowStepId = "prompt" | "evidence" | "preferences";

const starterPrompts: { label: string; body: string }[] = [
  {
    label: "Deploy mismatch",
    body:
      "Production deploy works locally but fails after release with a module resolution error.",
  },
  {
    label: "Migration slowdown",
    body:
      "App is slower after the latest migration; users report intermittent timeouts.",
  },
  {
    label: "Conflicting signals",
    body:
      "Customer workflow returns 500; logs, screenshots, and notes disagree on the cause.",
  },
];

const FLOW_STEPS: { id: FlowStepId; label: string }[] = [
  { id: "prompt", label: "Problem" },
  { id: "evidence", label: "Files" },
  { id: "preferences", label: "Direction" },
] as const;

const SOLVE_OPTIONS: { id: CaseSolveModeValue; label: string }[] = [
  { id: "quick_patch", label: "Quick patch" },
  { id: "proper_fix", label: "Proper fix" },
  { id: "strategic_improvement", label: "Strategic" },
];

const LENS_OPTIONS: { id: CaseProblemLensValue | null; label: string }[] = [
  { id: null, label: "Auto" },
  { id: "code", label: "Code" },
  { id: "ux_ui", label: "UX / UI" },
  { id: "product", label: "Product" },
  { id: "doctrine", label: "Doctrine" },
  { id: "mixed", label: "Mixed" },
];

const SOLVE_OPTION_COPY: Record<CaseSolveModeValue, string> = {
  quick_patch: "Fastest safe move.",
  proper_fix: "Balanced and durable.",
  strategic_improvement: "Fix plus cleanup.",
};

const LENS_OPTION_COPY: Record<NonNullable<CaseProblemLensValue> | "auto", string> = {
  auto: "Let Targ infer the angle from the case.",
  code: "Bias toward runtime and code behavior.",
  ux_ui: "Bias toward screens, states, and flows.",
  product: "Bias toward intent and workflow expectations.",
  doctrine: "Bias toward rules and process mismatches.",
  mixed: "Treat the case as cross-functional.",
};

const ONBOARDING_STORAGE_KEY = "targ-home-onboarding-complete";

function stepCopy(step: FlowStepId) {
  if (step === "prompt") {
    return "Describe what needs work.";
  }

  if (step === "evidence") {
    return "Attach proof if it helps.";
  }

  return "Pick how Targ should shape the output.";
}

export function HomeCaseComposer({
  workspaceId,
  initialWorkspacePlaybook,
}: HomeCaseComposerProps) {
  const shellChrome = useAppShellChrome();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const initialCaseDefaults = initialWorkspacePlaybook
    ? deriveCaseDefaultsFromPlaybook(initialWorkspacePlaybook)
    : null;

  const [currentStep, setCurrentStep] = useState<FlowStepId>("prompt");
  const [userProblemStatement, setUserProblemStatement] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [workspacePlaybook, setWorkspacePlaybook] =
    useState<WorkspacePlaybook | null>(initialWorkspacePlaybook);
  const [onboardingState, setOnboardingState] = useState<"loading" | "visible" | "hidden">(
    "loading"
  );
  const [solveMode, setSolveMode] = useState<CaseSolveModeValue | null>(
    initialCaseDefaults?.solveMode ?? "proper_fix"
  );
  const [problemLens, setProblemLens] = useState<CaseProblemLensValue | null>(
    initialCaseDefaults?.problemLens ?? null
  );

  useEffect(() => {
    if (!workspacePlaybook) {
      setOnboardingState("hidden");
      return;
    }
    const hasSeenOnboarding = window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1";
    setOnboardingState(hasSeenOnboarding ? "hidden" : "visible");
  }, [workspacePlaybook]);

  useEffect(() => {
    if (!workspacePlaybook) {
      return;
    }

    const defaults = deriveCaseDefaultsFromPlaybook(workspacePlaybook);
    setSolveMode(defaults.solveMode);
    setProblemLens(defaults.problemLens);
  }, [workspacePlaybook]);

  const homeOnboardingLayoutActive =
    !workspacePlaybook ||
    (workspacePlaybook && (onboardingState === "loading" || onboardingState === "visible"));

  useEffect(() => {
    shellChrome?.setHomeOnboardingLayoutActive(homeOnboardingLayoutActive);
    return () => {
      shellChrome?.setHomeOnboardingLayoutActive(false);
    };
  }, [homeOnboardingLayoutActive, shellChrome]);

  const attachmentItems = useMemo(
    () =>
      selectedFiles.map((file) => {
        const lowerName = file.name.toLowerCase();
        const notices: string[] = [];

        if (
          !file.type.startsWith("image/") &&
          !file.type.startsWith("text/") &&
          !lowerName.endsWith(".log") &&
          !lowerName.endsWith(".txt") &&
          !lowerName.endsWith(".md") &&
          !lowerName.endsWith(".json") &&
          !lowerName.endsWith(".ts") &&
          !lowerName.endsWith(".tsx") &&
          !lowerName.endsWith(".js") &&
          !lowerName.endsWith(".py") &&
          !lowerName.endsWith(".sql")
        ) {
          notices.push("May stay attached as raw context");
        }

        if (file.type.startsWith("image/")) {
          notices.push("Useful if the screenshot shows the issue clearly");
        }

        if (notices.length === 0) {
          notices.push("Ready to attach to the case");
        }

        return {
          key: `${file.name}-${file.size}`,
          name: file.name,
          notices,
        };
      }),
    [selectedFiles]
  );

  const currentStepIndex = FLOW_STEPS.findIndex((step) => step.id === currentStep);
  const isPromptReady = userProblemStatement.trim().length > 0;
  const selectedSolveCopy = SOLVE_OPTION_COPY[solveMode ?? "proper_fix"];
  const selectedLensCopy = LENS_OPTION_COPY[(problemLens ?? "auto") as keyof typeof LENS_OPTION_COPY];
  const promptPreview =
    userProblemStatement.trim().length > 0
      ? userProblemStatement.trim()
      : "No problem statement yet.";

  function removeSelectedFile(targetKey: string) {
    setSelectedFiles((current) =>
      current.filter((file) => `${file.name}-${file.size}` !== targetKey)
    );
  }

  function appendFiles(files: FileList | File[]) {
    const incoming = Array.from(files);

    if (incoming.length === 0) {
      return;
    }

    setSelectedFiles((current) => {
      const next = [...current];

      for (const file of incoming) {
        const key = `${file.name}-${file.size}`;

        if (!next.some((item) => `${item.name}-${item.size}` === key)) {
          next.push(file);
        }
      }

      return next;
    });
  }

  async function uploadFilesToCase(caseId: string, files: File[]) {
    for (const file of files) {
      const presignResponse = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          caseId,
          originalName: file.name,
          mimeType: file.type,
          size: file.size,
        }),
      });

      const presignData = (await presignResponse.json().catch(() => null)) as
        | {
            error?: string;
            uploadUrl?: string;
          }
        | null;

      if (!presignResponse.ok || !presignData?.uploadUrl) {
        throw new Error(presignData?.error ?? `Could not prepare ${file.name}.`);
      }

      const formData = new FormData();
      formData.append("file", file);

      const uploadResponse = await fetch(presignData.uploadUrl, {
        method: "POST",
        body: formData,
      });

      const uploadData = (await uploadResponse.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!uploadResponse.ok) {
        throw new Error(uploadData?.error ?? `Could not upload ${file.name}.`);
      }
    }
  }

  async function handleSubmit() {
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/cases", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId,
          userProblemStatement,
          ...(solveMode ? { solveMode } : {}),
          ...(problemLens ? { problemLens } : {}),
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string; case?: { id: string } }
        | null;

      if (!response.ok) {
        setError(data?.error ?? "Could not create the case.");
        return;
      }

      if (!data?.case?.id) {
        setError("Case created but response was incomplete. Refresh and check Cases.");
        return;
      }

      if (selectedFiles.length > 0) {
        await uploadFilesToCase(data.case.id, selectedFiles);
      }

      router.push(`/cases/${data.case.id}`);
      router.refresh();
    } catch {
      setError("Network or server error. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function goToStep(step: FlowStepId) {
    setCurrentStep(step);
    setError(null);
  }

  function goToNextStep() {
    if (currentStep === "prompt") {
      goToStep("evidence");
      return;
    }

    if (currentStep === "evidence") {
      goToStep("preferences");
    }
  }

  function goToPreviousStep() {
    if (currentStep === "evidence") {
      goToStep("prompt");
      return;
    }

    if (currentStep === "preferences") {
      goToStep("evidence");
    }
  }

  function completeOnboarding() {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    setOnboardingState("hidden");

    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
    });
  }

  function handlePlaybookComplete(playbook: WorkspacePlaybook) {
    setWorkspacePlaybook(playbook);
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    setOnboardingState("hidden");

    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
    });
  }

  if (!workspacePlaybook) {
    return (
      <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-1 flex-col">
        <WorkspacePlaybookOnboarding
          workspaceId={workspaceId}
          onComplete={handlePlaybookComplete}
        />
      </div>
    );
  }

  if (onboardingState === "loading") {
    return (
      <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-1 flex-col">
        <div className="h-full min-h-0 flex-1 animate-pulse rounded-[30px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]" />
      </div>
    );
  }

  if (onboardingState === "visible") {
    return (
      <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-1 flex-col">
        <HomeOnboarding onStart={completeOnboarding} />
      </div>
    );
  }

  return (
    <div className="targ-home-shell-enter mx-auto flex min-h-[calc(100dvh-12rem)] w-full max-w-[48rem] flex-col items-center justify-center">
      <div className="targ-home-shell-enter mb-2 flex w-full max-w-[40rem] items-center justify-between gap-3 [animation-delay:40ms]">
        <div>
          <p className="targ-eyebrow">New case</p>
          <p className="mt-0.5 text-[13px] text-[var(--color-text-secondary)]">
            {stepCopy(currentStep)}
          </p>
        </div>
        <div className="inline-flex items-center gap-1 rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-1">
          {FLOW_STEPS.map((step, index) => {
            const isActive = step.id === currentStep;
            const isAvailable = index <= currentStepIndex;

            return (
              <button
                key={step.id}
                type="button"
                disabled={!isAvailable}
                onClick={() => goToStep(step.id)}
                className={cn(
                  "targ-home-chip-enter rounded-full px-3 py-1.5 text-[12px] font-medium transition-[background-color,color,opacity] duration-[var(--motion-fast)]",
                  isActive
                    ? "bg-[rgba(95,168,166,0.16)] text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-muted)]",
                  !isAvailable && "cursor-not-allowed opacity-45"
                )}
                style={{ animationDelay: `${80 + index * 40}ms` }}
              >
                {step.label}
              </button>
            );
          })}
        </div>
      </div>

      <Surface
        tone="raised"
        padding="none"
        className={cn(
          "min-h-[22.75rem] w-full max-w-[40rem] overflow-hidden rounded-[26px] border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(24,27,30,0.96),rgba(19,21,24,0.96))] shadow-[0_16px_34px_rgba(0,0,0,0.18)] transition-[border-color,background-color,box-shadow] duration-[var(--motion-base)] sm:min-h-[24.25rem]",
          currentStep === "evidence" &&
            isDraggingFiles &&
            "border-[rgba(95,168,166,0.3)] bg-[linear-gradient(180deg,rgba(24,31,34,0.98),rgba(18,21,24,0.98))] shadow-[0_0_0_1px_rgba(95,168,166,0.1),0_24px_60px_rgba(0,0,0,0.24)]"
        )}
        onDragEnter={(event) => {
          if (currentStep !== "evidence") {
            return;
          }

          event.preventDefault();
          setIsDraggingFiles(true);
        }}
        onDragOver={(event) => {
          if (currentStep !== "evidence") {
            return;
          }

          event.preventDefault();
          setIsDraggingFiles(true);
        }}
        onDragLeave={(event) => {
          if (currentStep !== "evidence") {
            return;
          }

          event.preventDefault();

          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }

          setIsDraggingFiles(false);
        }}
        onDrop={(event) => {
          if (currentStep !== "evidence") {
            return;
          }

          event.preventDefault();
          setIsDraggingFiles(false);
          appendFiles(event.dataTransfer.files);
        }}
      >
        <div key={currentStep} className="targ-home-stage-enter flex min-h-[22.75rem] flex-col p-3.5 sm:min-h-[24.25rem] sm:p-4">
          {currentStep === "prompt" ? (
            <>
              <textarea
                ref={promptRef}
                value={userProblemStatement}
                onChange={(event) => {
                  setUserProblemStatement(event.target.value);
                  if (error) {
                    setError(null);
                  }
                }}
                placeholder="What needs to be worked on?"
                rows={7}
                className="targ-home-shell-enter targ-home-prompt-textarea min-h-[8.5rem] w-full flex-1 resize-none border-none bg-transparent text-[22px] leading-[1.34] tracking-[-0.04em] text-[var(--color-text-primary)] outline-none placeholder:text-[rgba(167,175,183,0.46)] [animation-delay:40ms] sm:min-h-[9rem] sm:text-[28px]"
              />

              <div className="mt-auto space-y-3">
                <div className="flex flex-wrap gap-2">
                  {starterPrompts.map((item, index) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        setUserProblemStatement(item.body);
                        setError(null);
                      }}
                      className="targ-home-chip-enter rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition-[border-color,background-color,color] duration-[var(--motion-fast)] hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.045)] hover:text-[var(--color-text-primary)]"
                      style={{ animationDelay: `${90 + index * 40}ms` }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div className="targ-home-shell-enter flex items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] px-0.5 pt-3 [animation-delay:150ms]">
                  <p className="text-[12px] text-[var(--color-text-muted)]">
                    Start with the signal. Keep it short and specific.
                  </p>
                  <Button onClick={goToNextStep} disabled={!isPromptReady} className="gap-2">
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {currentStep === "evidence" ? (
            <>
              <div className="targ-problem-preview-enter mb-3 rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.025)] px-3.5 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                  Problem
                </p>
                <p className="mt-1.5 line-clamp-2 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                  {promptPreview}
                </p>
              </div>

              <div className="targ-home-shell-enter rounded-[22px] border border-dashed border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.025)] px-4 py-5 text-center transition-[border-color,background-color] duration-[var(--motion-base)] [animation-delay:40ms]">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]">
                  <Files className="h-5 w-5 text-[var(--color-accent-primary)]" />
                </div>
                <p className="mt-3 text-[15px] font-semibold text-[var(--color-text-primary)]">
                  Drag files here or add them manually
                </p>
                <p className="mt-1.5 text-[12px] leading-[19px] text-[var(--color-text-muted)]">
                  Logs, screenshots, patches, and notes are all fair game.
                </p>
                <Button
                  variant="secondary"
                  className="mt-4"
                  id="composer-add-files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Add files
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  aria-labelledby="composer-add-files"
                  onChange={(event) => appendFiles(event.target.files ?? [])}
                />
              </div>

              {selectedFiles.length > 0 ? (
                <div className="targ-home-shell-enter mt-3 space-y-2.5 [animation-delay:110ms]">
                  <div className="flex flex-wrap gap-2">
                    {attachmentItems.map((item, index) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => removeSelectedFile(item.key)}
                        className="targ-home-chip-enter targ-chip targ-chip-subtle max-w-full truncate transition-[border-color,background-color] duration-[var(--motion-fast)] hover:border-[rgba(255,255,255,0.1)]"
                        style={{ animationDelay: `${140 + index * 28}ms` }}
                        title={`Remove ${item.name}`}
                      >
                        <span className="truncate">{item.name}</span>
                        <span className="ml-1 shrink-0 opacity-70">×</span>
                      </button>
                    ))}
                  </div>
                  <div className="space-y-1">
                    {attachmentItems.slice(0, 2).map((item, index) => (
                      <p
                        key={`${item.key}-notice`}
                        className="targ-home-chip-enter text-[12px] leading-[18px] text-[var(--color-text-muted)]"
                        style={{ animationDelay: `${190 + index * 35}ms` }}
                      >
                        <span className="text-[var(--color-text-secondary)]">{item.name}</span>
                        <span className="mx-1.5 text-[var(--color-border-subtle)]">·</span>
                        {item.notices[0]}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}

              {error ? (
                <div key={error} className="mt-4 targ-inline-alert-enter targ-callout-critical text-sm">
                  {error}
                </div>
              ) : null}

              <div className="targ-home-shell-enter mt-auto flex items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] pt-3 [animation-delay:180ms]">
                <Button variant="secondary" onClick={goToPreviousStep} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={goToNextStep}
                    className="text-[12px] font-medium text-[var(--color-text-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-text-secondary)]"
                  >
                    Skip
                  </button>
                  <Button onClick={goToNextStep} className="gap-2">
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {currentStep === "preferences" ? (
            <>
              <div className="targ-problem-preview-enter mb-3 rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.025)] px-3.5 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                  Problem
                </p>
                <p className="mt-1.5 line-clamp-2 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                  {promptPreview}
                </p>
              </div>

              <div className="space-y-4">
                <div className="targ-home-shell-enter [animation-delay:50ms]">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                    Resolution style
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {SOLVE_OPTIONS.map((opt, index) => {
                      const active = solveMode === opt.id;

                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setSolveMode(opt.id)}
                          className={cn(
                            "targ-home-chip-enter rounded-full border px-3 py-1.5 text-[12px] font-medium transition-[border-color,background-color,color] duration-[var(--motion-fast)]",
                            active
                              ? "border-[rgba(95,168,166,0.3)] bg-[rgba(95,168,166,0.12)] text-[var(--color-text-primary)]"
                              : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[var(--color-text-secondary)] hover:border-[rgba(255,255,255,0.14)] hover:text-[var(--color-text-primary)]"
                          )}
                          style={{ animationDelay: `${80 + index * 35}ms` }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">{selectedSolveCopy}</p>
                </div>

                <div className="targ-home-shell-enter [animation-delay:120ms]">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                    Perspective
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {LENS_OPTIONS.map((opt, index) => {
                      const active =
                        opt.id === null ? problemLens === null : problemLens === opt.id;

                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => setProblemLens(opt.id)}
                          className={cn(
                            "targ-home-chip-enter rounded-full border px-3 py-1.5 text-[12px] font-medium transition-[border-color,background-color,color] duration-[var(--motion-fast)]",
                            active
                              ? "border-[rgba(95,168,166,0.3)] bg-[rgba(95,168,166,0.12)] text-[var(--color-text-primary)]"
                              : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[var(--color-text-secondary)] hover:border-[rgba(255,255,255,0.14)] hover:text-[var(--color-text-primary)]"
                          )}
                          style={{ animationDelay: `${150 + index * 28}ms` }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">{selectedLensCopy}</p>
                </div>
              </div>

              {error ? (
                <div key={error} className="mt-4 targ-inline-alert-enter targ-callout-critical text-sm">
                  {error}
                </div>
              ) : null}

              <div className="targ-home-shell-enter mt-auto flex items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] pt-3 [animation-delay:210ms]">
                <Button variant="secondary" onClick={goToPreviousStep} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={isSubmitting || !isPromptReady}
                  className="gap-2"
                >
                  {isSubmitting ? "Creating case…" : "Create case"}
                  {isSubmitting ? null : <Sparkles className="h-4 w-4" />}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Surface>
    </div>
  );
}
