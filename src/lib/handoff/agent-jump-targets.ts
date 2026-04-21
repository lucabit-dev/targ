/**
 * Phase 3.0 — Agent jump targets for Cursor / Claude Code / Codex handoffs.
 *
 * Prepends a compact "## Where to start" section so coding agents open the
 * right file:line first (likely culprit / co-culprits aligned with blame and
 * stack frames), instead of reading the packet top-down blindly.
 */

import type { CommitRef, HandoffPacket, RepoLocation } from "@/lib/handoff/packet";
import { buildHandoffBlobUrl } from "@/lib/handoff/github-blob-url";

export type AgentJumpLine = {
  /** Display label for the bullet. */
  label: string;
  /** Optional short tag, e.g. PR number or 7-char sha. */
  tag?: string;
  location: RepoLocation;
};

function findCommitRef(
  regressions: CommitRef[] | undefined,
  sha: string
): CommitRef | undefined {
  return regressions?.find((r) => r.sha === sha);
}

function formatTag(commit: CommitRef): string | undefined {
  if (commit.prNumber) return `#${commit.prNumber}`;
  if (commit.sha.length >= 7) return commit.sha.slice(0, 7);
  return undefined;
}

/**
 * Picks the best RepoLocation for a suspected-regression SHA:
 *   1. Stack / evidence line where blame matches this SHA (Phase 2.10).
 *   2. Stack line whose file is in the commit's touchedFiles.
 *   3. First stack line with a positive line number.
 */
export function pickLocationForCulpritSha(
  sha: string,
  commit: CommitRef | undefined,
  stackLocations: RepoLocation[]
): RepoLocation | null {
  const touched = new Set(commit?.touchedFiles ?? []);

  for (const loc of stackLocations) {
    if (!loc.line || !Number.isFinite(loc.line) || loc.line <= 0) continue;
    if (loc.blame?.commitSha === sha) return loc;
  }
  for (const loc of stackLocations) {
    if (!loc.line || !Number.isFinite(loc.line) || loc.line <= 0) continue;
    if (touched.has(loc.file)) return loc;
  }
  for (const loc of stackLocations) {
    if (loc.line && Number.isFinite(loc.line) && loc.line > 0) return loc;
  }
  return null;
}

function collectStackLocations(packet: HandoffPacket): RepoLocation[] {
  const out: RepoLocation[] = [];
  const seen = new Set<string>();
  const push = (loc: RepoLocation) => {
    const key = `${loc.file}:${loc.line ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(loc);
  };
  for (const loc of packet.repoContext?.stackLocations ?? []) push(loc);
  if (packet.read.affectedArea.repoLocation) {
    push(packet.read.affectedArea.repoLocation);
  }
  return out;
}

/**
 * Ordered jump lines for the handoff preamble. Dedupes by `file:line`
 * (keeps the highest-priority label).
 */
export function buildAgentJumpLines(packet: HandoffPacket): AgentJumpLine[] {
  const ctx = packet.repoContext;
  const regressions = ctx?.suspectedRegressions;
  const stackLocs = collectStackLocations(packet);
  const lines: AgentJumpLine[] = [];
  const seenKey = new Set<string>();

  const push = (entry: AgentJumpLine) => {
    const loc = entry.location;
    if (!loc.line || !Number.isFinite(loc.line) || loc.line <= 0) return;
    const key = `${loc.file}:${loc.line}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);
    lines.push(entry);
  };

  const primary = ctx?.likelyCulprit;
  if (primary) {
    const ref = findCommitRef(regressions, primary.sha);
    const loc = pickLocationForCulpritSha(primary.sha, ref, stackLocs);
    if (loc) {
      push({
        label: "Likely culprit",
        tag: ref ? formatTag(ref) : undefined,
        location: loc,
      });
    }
  }

  for (const co of ctx?.coCulprits ?? []) {
    const ref = findCommitRef(regressions, co.sha);
    const loc = pickLocationForCulpritSha(co.sha, ref, stackLocs);
    if (loc) {
      push({
        label: "Co-culprit",
        tag: ref ? formatTag(ref) : undefined,
        location: loc,
      });
    }
  }

  // Fallback: first stack-only location not already listed (e.g. no culprit chip).
  if (lines.length === 0) {
    for (const loc of packet.repoContext?.stackLocations ?? []) {
      if (loc.line && Number.isFinite(loc.line) && loc.line > 0) {
        push({
          label: "Stack trace",
          location: loc,
        });
        break;
      }
    }
  }

  if (lines.length === 0 && packet.read.affectedArea.repoLocation) {
    const loc = packet.read.affectedArea.repoLocation;
    if (loc.line && Number.isFinite(loc.line) && loc.line > 0) {
      push({
        label: "Affected area",
        location: loc,
      });
    }
  }

  return lines;
}

/**
 * Markdown block for "## Where to start" or "" when nothing to add.
 * Kept short for Cursor URL budget (~3.5 KB body).
 */
export function renderWhereToStartSection(packet: HandoffPacket): string {
  const jumps = buildAgentJumpLines(packet);
  if (jumps.length === 0) return "";

  const ctx = packet.repoContext;
  const repoHint =
    ctx?.repoFullName && ctx?.ref
      ? `\`${ctx.repoFullName}\` @ \`${ctx.ref.slice(0, 12)}${ctx.ref.length > 12 ? "…" : ""}\``
      : null;

  const bullets = jumps.map((j, i) => {
    const { file, line } = j.location;
    const label = j.tag ? `${j.label} (${j.tag})` : j.label;
    const url = buildHandoffBlobUrl(j.location, ctx);
    const locMd = url
      ? `[\`${file}:${line}\`](${url})`
      : `\`${file}:${line}\``;
    return `${i + 1}. **${label}** — ${locMd}`;
  });

  const editorHint =
    "In **Cursor / VS Code**: press **Cmd+P** (Mac) or **Ctrl+P** (Windows/Linux), then type the `path:line` above to jump.";

  const parts = [
    "## Where to start",
    "",
    repoHint ? `Repo: ${repoHint}.` : null,
    "",
    "Open these in order before editing elsewhere:",
    "",
    ...bullets.map((b) => `- ${b}`),
    "",
    editorHint,
  ].filter((line): line is string => line !== null);

  return `${parts.join("\n")}\n`;
}
