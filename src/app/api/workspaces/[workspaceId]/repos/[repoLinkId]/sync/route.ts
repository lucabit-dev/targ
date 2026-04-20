import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { RepoIndexError, syncRepoTree } from "@/lib/services/repo-index-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{ workspaceId: string; repoLinkId: string }>;
};

/// Triggers a tree-only sync for the given repo link. The UI "Re-sync" button
/// calls this directly; it is also used by the lazy-resync flow at packet
/// generation time.
///
/// POST body is optional. When `reuseExisting` is explicitly false, we will
/// re-read the tree even if a READY snapshot already exists at HEAD — useful
/// when the user suspects the classifier or cap behaviour changed and wants
/// a forced rebuild.
export async function POST(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { workspaceId, repoLinkId } = await context.params;

  let reuseExisting = true;
  try {
    const body = (await request.json().catch(() => null)) as
      | { reuseExisting?: unknown }
      | null;
    if (body && typeof body.reuseExisting === "boolean") {
      reuseExisting = body.reuseExisting;
    }
  } catch {
    // Body parsing failures are ignored; defaults apply.
  }

  try {
    const snapshot = await syncRepoTree({
      userId,
      workspaceId,
      repoLinkId,
      reuseExisting,
    });
    return NextResponse.json({ snapshot });
  } catch (error) {
    if (error instanceof RepoIndexError) {
      const status = statusFromRepoIndexCode(error.code);
      return jsonError(error.message, status);
    }
    console.error("Repo sync failed", error);
    return jsonError("Failed to sync repository.", 500);
  }
}

function statusFromRepoIndexCode(code: string): number {
  switch (code) {
    case "workspace_access_denied":
    case "repo_link_not_found":
      return 404;
    case "repo_not_found":
    case "branch_not_found":
      return 404;
    case "github_not_connected":
      return 409;
    case "github_access_denied":
      return 403;
    default:
      return 500;
  }
}
