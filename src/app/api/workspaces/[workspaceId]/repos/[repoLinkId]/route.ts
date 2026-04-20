import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import {
  disconnectRepoFromWorkspace,
  RepoLinkError,
} from "@/lib/services/repo-link-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{ workspaceId: string; repoLinkId: string }>;
};

export async function DELETE(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { workspaceId, repoLinkId } = await context.params;

  try {
    await disconnectRepoFromWorkspace({ userId, workspaceId, repoLinkId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RepoLinkError) {
      const status =
        error.code === "workspace_not_found" || error.code === "repo_not_found"
          ? 404
          : 400;
      return jsonError(error.message, status);
    }
    console.error("Repo disconnect failed", error);
    return jsonError("Failed to disconnect repository.", 500);
  }
}
