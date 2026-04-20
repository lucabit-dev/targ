"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Chip } from "@/components/ui/primitives";
import { cn } from "@/lib/utils/cn";

type HandoffTargetId =
  | "cursor"
  | "markdown"
  | "claude_code"
  | "codex"
  | "copilot_ws"
  | "github_issue"
  | "linear_issue";

type TargetOption = {
  id: HandoffTargetId;
  label: string;
  hint: string;
  /**
   * When set, the option is rendered as disabled with this reason as tooltip.
   * Phase-gated per `src/lib/handoff/targets.ts` — keep these strings aligned
   * with the server-side `notYetAvailable.reason` so a user who clicks anyway
   * (via API) sees the same explanation.
   */
  disabledReason?: string;
};

const TARGETS: TargetOption[] = [
  {
    id: "cursor",
    label: "Open in Cursor",
    hint: "Deep link, opens with the packet as prompt.",
  },
  {
    id: "markdown",
    label: "Copy Markdown",
    hint: "Paste anywhere — Slack, PR description, doc.",
  },
  {
    id: "claude_code",
    label: "Copy for Claude Code",
    hint: "Wrapped in a <targ_handoff> tag for reliable parsing.",
  },
  {
    id: "codex",
    label: "Copy for Codex",
    hint: "Formatted for paste into Codex CLI or web.",
  },
  {
    id: "copilot_ws",
    label: "Copy for Copilot Workspaces",
    hint: "Plain Markdown task description with agent instructions.",
  },
  {
    id: "github_issue",
    label: "Open GitHub issue",
    hint: "Dispatch as a new issue in the connected repo.",
    disabledReason: "Connect a GitHub repo to your workspace first (Phase 5).",
  },
  {
    id: "linear_issue",
    label: "Open Linear issue",
    hint: "Dispatch to the connected Linear workspace.",
    disabledReason: "Linear integration is not enabled yet (Phase 4).",
  },
];

type HandoffResult = {
  handoffId: string;
  target: HandoffTargetId;
  kind: "copy" | "deep_link" | "dispatch";
  packetMd: string;
  url?: string;
  truncationSteps: string[];
  usedMinimalPacket: boolean;
};

type Feedback = {
  kind: "success" | "error" | "info";
  message: string;
  /**
   * For copy-targets that failed the clipboard write, we surface the rendered
   * packet so the user can copy it manually from a dialog.
   */
  fallbackText?: string;
};

type HandoffActionsProps = {
  caseId: string;
  diagnosisId: string;
  disabled?: boolean;
  disabledReason?: string;
};

const FEEDBACK_TIMEOUT_MS = 5_000;

export function HandoffActions({
  caseId,
  diagnosisId,
  disabled = false,
  disabledReason,
}: HandoffActionsProps) {
  const [pendingTarget, setPendingTarget] = useState<HandoffTargetId | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss ephemeral feedback; fallback-bearing feedback stays until the
  // user closes it so we don't hide the manual-copy escape hatch.
  useEffect(() => {
    if (!feedback || feedback.fallbackText) return;
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(
      () => setFeedback(null),
      FEEDBACK_TIMEOUT_MS
    );
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, [feedback]);

  const handleSelect = useCallback(
    async (target: TargetOption) => {
      if (disabled || pendingTarget || target.disabledReason) return;
      setPendingTarget(target.id);
      setFeedback(null);

      try {
        const response = await fetch(`/api/cases/${caseId}/handoff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: target.id, diagnosisId }),
        });

        const data = (await response.json().catch(() => null)) as
          | { handoff?: HandoffResult; error?: string }
          | null;

        if (!response.ok || !data?.handoff) {
          setFeedback({
            kind: "error",
            message:
              data?.error ??
              `Could not build the ${target.label.toLowerCase()} packet.`,
          });
          return;
        }

        const result = data.handoff;
        await deliverHandoffResult(result, target, setFeedback);
      } catch (error) {
        setFeedback({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Network error while requesting the handoff packet.",
        });
      } finally {
        setPendingTarget(null);
      }
    },
    [caseId, diagnosisId, disabled, pendingTarget]
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
            Hand off
          </p>
          <Chip tone="subtle" className="text-[10px] leading-[14px]">
            Packet v1
          </Chip>
        </div>
        <p className="text-[11px] leading-[17px] text-[var(--color-text-muted)]">
          Ship this diagnosis to an AI agent or ticket system. The packet is
          grounded in the current evidence and carries a TARG back-link.
        </p>
      </div>

      {disabled && disabledReason ? (
        <p className="text-[11px] leading-[17px] text-[var(--color-state-warning)]">
          {disabledReason}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {TARGETS.map((target) => {
          const isPending = pendingTarget === target.id;
          const isLocked = Boolean(target.disabledReason) || disabled;
          return (
            <Button
              key={target.id}
              type="button"
              variant="secondary"
              onClick={() => handleSelect(target)}
              disabled={isLocked || Boolean(pendingTarget)}
              title={target.disabledReason ?? target.hint}
              className={cn(
                "min-h-8 rounded-[var(--radius-sm)] px-2.5 py-0 text-[12px] font-semibold leading-4",
                isLocked && "opacity-60"
              )}
              aria-disabled={isLocked || undefined}
            >
              {isPending ? `${target.label}…` : target.label}
              {target.disabledReason ? (
                <span className="ms-1.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                  · soon
                </span>
              ) : null}
            </Button>
          );
        })}
      </div>

      {feedback ? (
        <FeedbackBanner
          feedback={feedback}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}
    </div>
  );
}

async function deliverHandoffResult(
  result: HandoffResult,
  target: TargetOption,
  setFeedback: (feedback: Feedback) => void
): Promise<void> {
  if (result.kind === "deep_link" && result.url) {
    try {
      window.open(result.url, "_blank", "noopener,noreferrer");
      setFeedback({
        kind: "success",
        message: result.usedMinimalPacket
          ? "Opened in Cursor with a compact packet (long evidence was trimmed)."
          : "Opened in Cursor with the full packet.",
      });
    } catch {
      setFeedback({
        kind: "error",
        message: "Browser blocked the Cursor deep link. Copy the URL manually.",
        fallbackText: result.url,
      });
    }
    return;
  }

  if (result.kind === "copy") {
    const wrote = await copyToClipboard(result.packetMd);
    if (wrote) {
      setFeedback({
        kind: "success",
        message: result.usedMinimalPacket
          ? `Copied a compact ${target.label.toLowerCase()} packet.`
          : `Copied ${target.label.toLowerCase()} to clipboard.`,
      });
    } else {
      setFeedback({
        kind: "error",
        message:
          "Clipboard is blocked in this context. Copy the packet below manually.",
        fallbackText: result.packetMd,
      });
    }
    return;
  }

  // Dispatch targets are currently server-gated; we only reach this branch if
  // the server evolves to accept them without the client catalogue catching up.
  setFeedback({
    kind: "info",
    message: `Dispatched as ${target.label.toLowerCase()}.`,
  });
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  // Fallback for non-secure contexts (e.g. http://localhost inside some sandboxes).
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function FeedbackBanner({
  feedback,
  onDismiss,
}: {
  feedback: Feedback;
  onDismiss: () => void;
}) {
  const toneClass =
    feedback.kind === "error"
      ? "border-[var(--color-state-critical)]/40 text-[var(--color-state-critical)]"
      : feedback.kind === "success"
        ? "border-[var(--color-state-success)]/40 text-[var(--color-state-success)]"
        : "border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-[var(--radius-sm)] border bg-[rgba(255,255,255,0.02)] px-3 py-2 text-[12px] leading-[18px]",
        toneClass
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p>{feedback.message}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          aria-label="Dismiss handoff status"
        >
          Dismiss
        </button>
      </div>
      {feedback.fallbackText ? (
        <textarea
          readOnly
          value={feedback.fallbackText}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-2 block max-h-48 w-full resize-y rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[11px] leading-[16px] text-[var(--color-text-primary)]"
        />
      ) : null}
    </div>
  );
}
