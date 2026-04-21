/**
 * Builds a GitHub blob URL for a RepoLocation when `repoContext` carries
 * `repoFullName` + `ref`. Shared by Markdown rendering and agent jump
 * targets (Phase 3.0).
 */

import type { HandoffPacket, RepoLocation } from "@/lib/handoff/packet";

export function buildHandoffBlobUrl(
  location: RepoLocation,
  repoContext: HandoffPacket["repoContext"] | undefined
): string | null {
  if (!repoContext) return null;
  if (!repoContext.repoFullName || !repoContext.ref) return null;
  const path = location.file
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const suffix =
    typeof location.line === "number" ? `#L${location.line}` : "";
  return `https://github.com/${repoContext.repoFullName}/blob/${repoContext.ref}/${path}${suffix}`;
}
