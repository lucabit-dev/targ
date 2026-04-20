"use client";

/**
 * Compact chip that shows — and lets the user change — the repo a case is
 * scoped to. The repo scope drives Handoff Packet enrichment (Phase 2.3):
 * when set, TARG resolves evidence hints against the linked repo's snapshot
 * and emits clickable GitHub blob URLs in the packet.
 *
 * Design notes:
 *   - Lives in the case header meta row alongside stage/confidence/updated.
 *     Kept intentionally compact so the header doesn't grow.
 *   - Workspace repo list is fetched lazily on first open; cached after that
 *     until the component re-mounts.
 *   - Unset state is explicit ("Not linked") so users know a single linked
 *     repo is auto-used (Phase 2.3 "one-repo-per-workspace" fallback) but
 *     still see the option to pin.
 *   - Changes PATCH the case via `/api/cases/[id]` and call
 *     `router.refresh()` so server-rendered state (header, downstream
 *     components that read `case.repoLink`) re-syncs.
 */

import { Check, ChevronDown, Link2, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils/cn";

export type CaseRepoLinkSummary = {
  id: string;
  ownerLogin: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
};

type RepoOption = {
  id: string;
  fullName: string;
  ownerLogin: string;
  repoName: string;
  defaultBranch: string;
};

type RepoListResponse = {
  repoLinks: Array<{
    id: string;
    fullName: string;
    ownerLogin: string;
    repoName: string;
    defaultBranch: string;
  }>;
};

type CaseRepoLinkPickerProps = {
  caseId: string;
  workspaceId: string;
  initialRepoLink: CaseRepoLinkSummary | null;
};

export function CaseRepoLinkPicker({
  caseId,
  workspaceId,
  initialRepoLink,
}: CaseRepoLinkPickerProps) {
  const router = useRouter();
  const [currentLink, setCurrentLink] = useState<CaseRepoLinkSummary | null>(
    initialRepoLink
  );
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RepoOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrentLink(initialRepoLink);
  }, [initialRepoLink]);

  const loadOptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/repos`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error("Could not load repositories.");
      }
      const data = (await response.json()) as RepoListResponse;
      setOptions(
        data.repoLinks.map((link) => ({
          id: link.id,
          fullName: link.fullName,
          ownerLogin: link.ownerLogin,
          repoName: link.repoName,
          defaultBranch: link.defaultBranch,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load repositories.");
      setOptions([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && options === null) {
        void loadOptions();
      }
      return next;
    });
  }, [loadOptions, options]);

  // Close on click-outside.
  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      const node = containerRef.current;
      if (!node) return;
      if (event.target instanceof Node && !node.contains(event.target)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commit = useCallback(
    async (repoLinkId: string | null) => {
      // Optimistic no-op when the selection matches what's already set.
      if ((currentLink?.id ?? null) === repoLinkId) {
        setOpen(false);
        return;
      }
      setSaving(true);
      setError(null);
      const previous = currentLink;
      // Optimistic update — revert on failure.
      if (repoLinkId === null) {
        setCurrentLink(null);
      } else {
        const match = options?.find((o) => o.id === repoLinkId);
        if (match) {
          setCurrentLink({
            id: match.id,
            ownerLogin: match.ownerLogin,
            repoName: match.repoName,
            defaultBranch: match.defaultBranch,
            remoteUrl: null,
          });
        }
      }
      try {
        const response = await fetch(`/api/cases/${caseId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoLinkId }),
        });
        if (!response.ok) {
          throw new Error("Could not update repository scope.");
        }
        const data = (await response.json()) as {
          repoLinkId: string | null;
          repoLink: CaseRepoLinkSummary | null;
        };
        setCurrentLink(data.repoLink);
        setOpen(false);
        // Refresh the server component tree so dependent surfaces see the
        // new scope on the next render (e.g. future handoff packets).
        router.refresh();
      } catch (err) {
        setCurrentLink(previous);
        setError(
          err instanceof Error
            ? err.message
            : "Could not update repository scope."
        );
      } finally {
        setSaving(false);
      }
    },
    [caseId, currentLink, options, router]
  );

  const label = currentLink
    ? `${currentLink.ownerLogin}/${currentLink.repoName}`
    : "Not linked";

  return (
    <div className="relative inline-flex" ref={containerRef}>
      <button
        type="button"
        onClick={handleToggle}
        disabled={saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          currentLink
            ? "Change the repo this case is scoped to. Drives Handoff Packet enrichment."
            : "Pin this case to a repo so Handoff Packets emit clickable GitHub links."
        }
        className={cn(
          "inline-flex items-center gap-1 rounded-[5px] px-2 py-0 min-h-[22px]",
          "text-[11px] font-semibold leading-4 tracking-[0.02em]",
          "border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)]",
          "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
          "transition-colors duration-[var(--motion-fast)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
          open && "text-[var(--color-text-primary)]"
        )}
      >
        <Link2 className="h-3 w-3" aria-hidden />
        <span className="truncate max-w-[14rem]">{label}</span>
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : (
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
        )}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Scope this case to a repository"
          className={cn(
            "absolute left-0 top-full z-40 mt-1 min-w-[18rem]",
            "rounded-[var(--radius-md)] border border-[var(--color-border-subtle)]",
            "bg-[var(--color-surface-1)] shadow-[0_10px_30px_rgba(0,0,0,0.08)]",
            "p-2"
          )}
        >
          <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Scope this case to a repo
          </div>
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-[var(--color-text-muted)]">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Loading repositories…
            </div>
          ) : null}
          {!loading && options && options.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-[var(--color-text-muted)]">
              No repositories linked to this workspace.{" "}
              <a
                href="/workspace"
                className="font-semibold text-[var(--color-accent-primary)] hover:underline"
              >
                Link one in workspace settings
              </a>
              .
            </div>
          ) : null}
          {!loading && options && options.length > 0 ? (
            <ul role="listbox" className="flex flex-col gap-0.5">
              <li>
                <RepoOptionRow
                  label="No repo · clear scope"
                  secondary="Packets will skip repo enrichment unless the workspace has exactly one linked repo."
                  selected={currentLink === null}
                  disabled={saving}
                  onSelect={() => commit(null)}
                />
              </li>
              {options.map((option) => (
                <li key={option.id}>
                  <RepoOptionRow
                    label={option.fullName}
                    secondary={`default branch: ${option.defaultBranch}`}
                    selected={currentLink?.id === option.id}
                    disabled={saving}
                    onSelect={() => commit(option.id)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <div className="mt-1 flex items-start gap-1.5 rounded-[var(--radius-sm)] bg-[rgba(255,0,0,0.04)] px-2 py-1.5 text-[11px] text-[var(--color-state-critical)]">
              <X className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="mt-1 flex justify-end px-2 pt-1">
            <Button
              variant="tertiary"
              type="button"
              onClick={() => setOpen(false)}
              className="min-h-7 px-2 text-[11px] font-semibold"
            >
              Close
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RepoOptionRow({
  label,
  secondary,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  secondary: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left",
        "text-[12px] leading-4 text-[var(--color-text-primary)]",
        "transition-colors duration-[var(--motion-fast)]",
        "hover:bg-[rgba(0,0,0,0.04)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        selected && "bg-[rgba(0,0,0,0.04)]"
      )}
    >
      <span className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center">
        {selected ? <Check className="h-3 w-3 text-[var(--color-accent-primary)]" aria-hidden /> : null}
      </span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="font-semibold">{label}</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {secondary}
        </span>
      </span>
    </button>
  );
}
