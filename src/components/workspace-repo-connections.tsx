"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Unlink,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

import { Button, Chip, FieldLabel } from "@/components/ui/primitives";
import { cn } from "@/lib/utils/cn";

type GithubAccount = {
  id: string;
  githubUserId: number;
  githubLogin: string;
  avatarUrl: string | null;
  scope: string;
  expiresAt: string | null;
};

type GithubAccountResponse = {
  oauthConfigured: boolean;
  account: GithubAccount | null;
};

type RepoLink = {
  id: string;
  workspaceId: string;
  connectedByUserId: string;
  fullName: string;
  ownerLogin: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL" | "UNKNOWN";
  lastSyncedAt: string | null;
  createdAt: string;
};

type SnapshotSummary = {
  id: string;
  repoLinkId: string;
  commitSha: string;
  branch: string;
  status: "SYNCING" | "READY" | "PARTIAL" | "FAILED";
  statusDetail: string | null;
  treeSyncedAt: string | null;
  symbolSyncedAt: string | null;
  fileCount: number;
  symbolCount: number;
  createdAt: string;
  updatedAt: string;
};

type RepoListResponse = {
  repoLinks: RepoLink[];
  snapshots: Record<string, SnapshotSummary>;
};

type RepoPickerEntry = {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  visibility: "public" | "private" | "internal" | "unknown";
  defaultBranch: string;
  htmlUrl: string;
  archived: boolean;
  permissions: { admin: boolean; push: boolean; pull: boolean };
};

type Props = {
  workspaceId: string;
  /// Optional hint from the URL (`?github_connected=1` after OAuth). Surfaces
  /// a success banner once; parent should strip it from the URL afterwards.
  initialConnectedHint?: boolean;
  /// Optional GitHub OAuth error code from the callback (`?github_error=...`).
  initialErrorHint?: string | null;
};

export function WorkspaceRepoConnections({
  workspaceId,
  initialConnectedHint,
  initialErrorHint,
}: Props) {
  const [accountState, setAccountState] = useState<GithubAccountResponse | null>(
    null
  );
  const [accountLoading, setAccountLoading] = useState(true);
  const [repoLinks, setRepoLinks] = useState<RepoLink[] | null>(null);
  const [repoLinksLoading, setRepoLinksLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotSummary>>({});
  const [syncing, setSyncing] = useState<string | null>(null);

  const [banner, setBanner] = useState<
    | { tone: "success" | "error" | "info"; text: string }
    | null
  >(() => {
    if (initialErrorHint) {
      return {
        tone: "error",
        text: describeOAuthErrorCode(initialErrorHint),
      };
    }
    if (initialConnectedHint) {
      return { tone: "success", text: "GitHub connected." };
    }
    return null;
  });

  const [showPicker, setShowPicker] = useState(false);

  const refreshAccount = useCallback(async () => {
    setAccountLoading(true);
    try {
      const response = await fetch("/api/github/account", {
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error("Failed to load GitHub account.");
      }
      setAccountState((await response.json()) as GithubAccountResponse);
    } catch (error) {
      setBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not load GitHub status.",
      });
    } finally {
      setAccountLoading(false);
    }
  }, []);

  const refreshRepoLinks = useCallback(async () => {
    setRepoLinksLoading(true);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/repos`,
        { credentials: "same-origin" }
      );
      if (!response.ok) {
        throw new Error("Failed to load linked repositories.");
      }
      const json = (await response.json()) as RepoListResponse;
      setRepoLinks(json.repoLinks);
      setSnapshots(json.snapshots ?? {});
    } catch (error) {
      setBanner({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not load linked repositories.",
      });
    } finally {
      setRepoLinksLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshAccount();
    void refreshRepoLinks();
  }, [refreshAccount, refreshRepoLinks]);

  const isConnected = Boolean(accountState?.account);
  const oauthConfigured = accountState?.oauthConfigured ?? false;

  const connectHref = useMemo(() => {
    const params = new URLSearchParams({ returnTo: "/workspace" });
    return `/api/auth/github/start?${params.toString()}`;
  }, []);

  const handleDisconnectGithub = useCallback(async () => {
    if (!confirm("Disconnect your GitHub account? Repo links remain but will need a reconnected account for live sync.")) {
      return;
    }
    try {
      const response = await fetch("/api/auth/github/disconnect", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error("Disconnect failed.");
      }
      await refreshAccount();
      setBanner({ tone: "info", text: "GitHub disconnected." });
    } catch (error) {
      setBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Disconnect failed.",
      });
    }
  }, [refreshAccount]);

  const handleRepoConnected = useCallback(
    async (repoLink: RepoLink) => {
      setShowPicker(false);
      setBanner({
        tone: "success",
        text: `Linked ${repoLink.fullName} to this workspace.`,
      });
      await refreshRepoLinks();
    },
    [refreshRepoLinks]
  );

  const handleResyncRepo = useCallback(
    async (repoLink: RepoLink, opts?: { force?: boolean }) => {
      setSyncing(repoLink.id);
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/repos/${repoLink.id}/sync`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reuseExisting: !opts?.force }),
          }
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(body?.error ?? "Failed to sync repository.");
        }
        const json = (await response.json()) as { snapshot: SnapshotSummary };
        setSnapshots((prev) => ({ ...prev, [repoLink.id]: json.snapshot }));
        setBanner({
          tone:
            json.snapshot.status === "PARTIAL"
              ? "info"
              : json.snapshot.status === "FAILED"
                ? "error"
                : "success",
          text:
            json.snapshot.status === "PARTIAL"
              ? `${repoLink.fullName} synced (partial: ${json.snapshot.statusDetail ?? "see snapshot"}).`
              : json.snapshot.status === "FAILED"
                ? `Sync failed for ${repoLink.fullName}: ${json.snapshot.statusDetail ?? "unknown error"}.`
                : `${repoLink.fullName} synced (${json.snapshot.fileCount} files).`,
        });
      } catch (error) {
        setBanner({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Failed to sync repository.",
        });
      } finally {
        setSyncing(null);
      }
    },
    [workspaceId]
  );

  const handleDisconnectRepo = useCallback(
    async (repoLink: RepoLink) => {
      if (
        !confirm(
          `Unlink ${repoLink.fullName} from this workspace? Existing cases scoped to this repo will keep their data but lose the live link.`
        )
      ) {
        return;
      }
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/repos/${repoLink.id}`,
          { method: "DELETE", credentials: "same-origin" }
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(body?.error ?? "Failed to unlink repository.");
        }
        await refreshRepoLinks();
        setBanner({
          tone: "info",
          text: `Unlinked ${repoLink.fullName}.`,
        });
      } catch (error) {
        setBanner({
          tone: "error",
          text:
            error instanceof Error ? error.message : "Failed to unlink repository.",
        });
      }
    },
    [refreshRepoLinks, workspaceId]
  );

  const bannerNode = banner ? (
    <div
      className={cn(
        "flex items-center gap-2 rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] leading-[18px]",
        banner.tone === "success" &&
          "border-[color:var(--color-status-success)]/40 bg-[color:var(--color-status-success)]/10 text-[color:var(--color-status-success)]",
        banner.tone === "error" &&
          "border-[color:var(--color-status-critical)]/40 bg-[color:var(--color-status-critical)]/10 text-[color:var(--color-status-critical)]",
        banner.tone === "info" &&
          "border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] text-[var(--color-text-secondary)]"
      )}
    >
      <span className="flex-1">{banner.text}</span>
      <button
        type="button"
        onClick={() => setBanner(null)}
        className="opacity-60 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : null;

  if (accountLoading && !accountState) {
    return (
      <div className="flex items-center gap-2 py-4 targ-meta text-[var(--color-text-muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Loading GitHub status…</span>
      </div>
    );
  }

  if (!oauthConfigured) {
    return (
      <div className="flex flex-col gap-3 py-4">
        {bannerNode}
        <div className="rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] px-3 py-3 targ-meta text-[var(--color-text-muted)]">
          <div className="mb-1 flex items-center gap-2 text-[var(--color-text-secondary)]">
            <GithubMark className="h-3.5 w-3.5" />
            <span className="font-medium">GitHub integration is not configured on this server.</span>
          </div>
          <p className="leading-[17px]">
            Set <code className="font-mono text-[11px]">GITHUB_OAUTH_CLIENT_ID</code> and{" "}
            <code className="font-mono text-[11px]">GITHUB_OAUTH_CLIENT_SECRET</code> in{" "}
            <code className="font-mono text-[11px]">.env</code>, then restart the app. See{" "}
            <code className="font-mono text-[11px]">.env.example</code> for the full setup steps.
          </p>
        </div>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="flex flex-col gap-3 py-4">
        {bannerNode}
        <div className="flex flex-col gap-3 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border-subtle)] px-3 py-4">
          <div className="flex items-start gap-3">
            <GithubMark className="mt-0.5 h-4 w-4 text-[var(--color-text-secondary)]" />
            <div className="flex-1">
              <div className="text-[14px] font-medium leading-[20px] text-[var(--color-text-primary)]">
                Connect your GitHub account
              </div>
              <p className="mt-1 targ-meta leading-[17px] text-[var(--color-text-muted)]">
                TARG needs read access to list your repos and pin packets to a
                real branch + commit SHA. Your token is encrypted at rest and
                never leaves this server.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={connectHref}
              className="targ-btn targ-btn-primary inline-flex items-center gap-1.5"
            >
              <GithubMark className="h-3.5 w-3.5" />
              Connect GitHub
            </a>
          </div>
        </div>
      </div>
    );
  }

  const account = accountState!.account!;

  return (
    <div className="flex flex-col gap-3 py-4">
      {bannerNode}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          {account.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={account.avatarUrl}
              alt=""
              className="h-6 w-6 rounded-full border border-[var(--color-border-subtle)]"
            />
          ) : (
            <GithubMark className="h-5 w-5 text-[var(--color-text-secondary)]" />
          )}
          <div className="flex flex-col">
            <span className="text-[13px] font-medium leading-[17px] text-[var(--color-text-primary)]">
              {account.githubLogin}
            </span>
            <span className="targ-micro leading-[15px] text-[var(--color-text-muted)]">
              Scope: {account.scope || "—"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="success" className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Connected
          </Chip>
          <Button
            variant="tertiary"
            onClick={handleDisconnectGithub}
            className="inline-flex items-center gap-1"
          >
            <Unlink className="h-3.5 w-3.5" />
            Disconnect
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <FieldLabel className="mb-0">Linked repositories</FieldLabel>
          <Button
            variant="secondary"
            onClick={() => setShowPicker((value) => !value)}
            className="inline-flex items-center gap-1"
          >
            <Plus className="h-3.5 w-3.5" />
            {showPicker ? "Cancel" : "Link repository"}
          </Button>
        </div>

        {showPicker ? (
          <RepoPicker
            workspaceId={workspaceId}
            linkedIdsByFullName={new Set((repoLinks ?? []).map((r) => r.fullName))}
            onConnected={handleRepoConnected}
            onCancel={() => setShowPicker(false)}
            onError={(message) =>
              setBanner({ tone: "error", text: message })
            }
          />
        ) : null}

        {repoLinksLoading && !repoLinks ? (
          <div className="flex items-center gap-2 py-3 targ-meta text-[var(--color-text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Loading linked repositories…</span>
          </div>
        ) : (repoLinks ?? []).length === 0 ? (
          <div className="rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border-subtle)] px-3 py-4 text-center targ-meta text-[var(--color-text-muted)]">
            No repositories linked to this workspace yet.
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-border-subtle)] rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]">
            {(repoLinks ?? []).map((repo) => {
              const snapshot = snapshots[repo.id];
              const isSyncing = syncing === repo.id;
              return (
                <li
                  key={repo.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                >
                  <div className="flex min-w-0 flex-col">
                    <a
                      href={repo.remoteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[13px] font-medium leading-[17px] text-[var(--color-text-primary)] hover:underline"
                    >
                      {repo.fullName}
                    </a>
                    <span className="truncate targ-micro leading-[15px] text-[var(--color-text-muted)]">
                      default branch: {repo.defaultBranch} · visibility: {repo.visibility.toLowerCase()}
                    </span>
                    <SnapshotMeta snapshot={snapshot} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <SnapshotChip snapshot={snapshot} syncing={isSyncing} />
                    <Button
                      variant="secondary"
                      onClick={() => handleResyncRepo(repo)}
                      disabled={isSyncing}
                      className="inline-flex items-center gap-1"
                    >
                      <RefreshCw
                        className={cn(
                          "h-3.5 w-3.5",
                          isSyncing && "animate-spin"
                        )}
                      />
                      {snapshot ? "Re-sync" : "Sync"}
                    </Button>
                    <Button
                      variant="tertiary"
                      onClick={() => handleDisconnectRepo(repo)}
                      className="inline-flex items-center gap-1"
                    >
                      <Unlink className="h-3.5 w-3.5" />
                      Unlink
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function RepoPicker({
  workspaceId,
  linkedIdsByFullName,
  onConnected,
  onCancel,
  onError,
}: {
  workspaceId: string;
  linkedIdsByFullName: Set<string>;
  onConnected: (repo: RepoLink) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [repos, setRepos] = useState<RepoPickerEntry[] | null>(null);
  const [reposLoading, setReposLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [linking, setLinking] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    try {
      const params = new URLSearchParams({ perPage: "50" });
      const response = await fetch(`/api/github/repos?${params.toString()}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? "Failed to fetch repositories.");
      }
      const json = (await response.json()) as { repos: RepoPickerEntry[] };
      setRepos(json.repos);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Failed to fetch repositories."
      );
      setRepos([]);
    } finally {
      setReposLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (repo) =>
        repo.fullName.toLowerCase().includes(q) ||
        (repo.description ?? "").toLowerCase().includes(q)
    );
  }, [repos, query]);

  const linkRepo = useCallback(
    async (repo: RepoPickerEntry) => {
      setLinking(repo.fullName);
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/repos`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ owner: repo.owner, name: repo.name }),
          }
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(body?.error ?? "Failed to link repository.");
        }
        const json = (await response.json()) as { repoLink: RepoLink };
        onConnected(json.repoLink);
      } catch (error) {
        onError(
          error instanceof Error ? error.message : "Failed to link repository."
        );
      } finally {
        setLinking(null);
      }
    },
    [onConnected, onError, workspaceId]
  );

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] p-3">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by owner/name or description…"
        className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-transparent px-2.5 py-1.5 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
      />

      {reposLoading ? (
        <div className="flex items-center gap-2 py-3 targ-meta text-[var(--color-text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Fetching your GitHub repositories…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-3 text-center targ-meta text-[var(--color-text-muted)]">
          {query
            ? "No matching repositories."
            : "GitHub returned no repositories for this account."}
        </div>
      ) : (
        <ul className="flex max-h-72 flex-col divide-y divide-[var(--color-border-subtle)] overflow-y-auto">
          {filtered.map((repo) => {
            const alreadyLinked = linkedIdsByFullName.has(repo.fullName);
            return (
              <li
                key={repo.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium leading-[17px] text-[var(--color-text-primary)]">
                    {repo.fullName}
                    {repo.archived ? (
                      <span className="ml-2 targ-micro text-[var(--color-text-muted)]">
                        archived
                      </span>
                    ) : null}
                  </span>
                  {repo.description ? (
                    <span className="truncate targ-micro leading-[15px] text-[var(--color-text-muted)]">
                      {repo.description}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Chip tone="subtle">{repo.visibility}</Chip>
                  <Button
                    variant="primary"
                    disabled={alreadyLinked || linking !== null}
                    onClick={() => linkRepo(repo)}
                  >
                    {alreadyLinked
                      ? "Linked"
                      : linking === repo.fullName
                        ? "Linking…"
                        : "Link"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-end">
        <Button variant="tertiary" onClick={onCancel}>
          Close
        </Button>
      </div>
    </div>
  );
}

function SnapshotChip({
  snapshot,
  syncing,
}: {
  snapshot: SnapshotSummary | undefined;
  syncing: boolean;
}) {
  if (syncing) {
    return (
      <Chip tone="subtle" className="inline-flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Syncing
      </Chip>
    );
  }
  if (!snapshot) {
    return (
      <Chip tone="subtle" className="inline-flex items-center gap-1">
        Not synced
      </Chip>
    );
  }
  switch (snapshot.status) {
    case "READY":
      return (
        <Chip tone="success" className="inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Synced
        </Chip>
      );
    case "PARTIAL":
      return (
        <Chip
          tone="warning"
          className="inline-flex items-center gap-1"
          title={snapshot.statusDetail ?? undefined}
        >
          <AlertTriangle className="h-3 w-3" />
          Partial
        </Chip>
      );
    case "FAILED":
      return (
        <Chip
          tone="critical"
          className="inline-flex items-center gap-1"
          title={snapshot.statusDetail ?? undefined}
        >
          <AlertTriangle className="h-3 w-3" />
          Failed
        </Chip>
      );
    case "SYNCING":
      return (
        <Chip tone="subtle" className="inline-flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Syncing
        </Chip>
      );
    default:
      return null;
  }
}

function SnapshotMeta({
  snapshot,
}: {
  snapshot: SnapshotSummary | undefined;
}) {
  if (!snapshot || !snapshot.treeSyncedAt) return null;
  const when = new Date(snapshot.treeSyncedAt);
  const shortSha = snapshot.commitSha.slice(0, 7);
  const files =
    snapshot.fileCount === 1 ? "1 file" : `${snapshot.fileCount.toLocaleString()} files`;
  return (
    <span className="truncate targ-micro leading-[15px] text-[var(--color-text-muted)]">
      {files} @ {shortSha} · synced {formatRelative(when)}
    </span>
  );
}

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return "just now";
  if (abs < hour) {
    const n = Math.round(abs / minute);
    return `${n}m ago`;
  }
  if (abs < day) {
    const n = Math.round(abs / hour);
    return `${n}h ago`;
  }
  const n = Math.round(abs / day);
  return `${n}d ago`;
}

function describeOAuthErrorCode(code: string): string {
  switch (code) {
    case "state_mismatch":
    case "invalid_state_shape":
    case "missing_code_or_state":
      return "GitHub OAuth state was invalid. Start again.";
    case "session_mismatch":
      return "You were signed out during the GitHub redirect. Sign in and retry.";
    case "token_exchange_failed":
      return "GitHub rejected the authorization code. Try again.";
    case "persist_failed":
      return "Could not store your GitHub credentials. Check server logs.";
    case "oauth_not_configured":
      return "GitHub OAuth is not configured on this server.";
    case "access_denied":
      return "You denied access. Reconnect if that was a mistake.";
    default:
      return `GitHub connection failed (${code}).`;
  }
}
