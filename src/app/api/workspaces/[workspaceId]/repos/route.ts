import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { listLatestSnapshotsByWorkspace } from "@/lib/services/repo-index-service";
import {
  connectRepoToWorkspace,
  listRepoLinksForWorkspace,
  RepoLinkError,
} from "@/lib/services/repo-link-service";
import { jsonError } from "@/lib/utils/http";
import { connectRepoRequestSchema } from "@/lib/validators";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { workspaceId } = await context.params;

  try {
    const [repoLinks, snapshots] = await Promise.all([
      listRepoLinksForWorkspace({ userId, workspaceId }),
      listLatestSnapshotsByWorkspace(workspaceId),
    ]);
    return NextResponse.json({ repoLinks, snapshots });
  } catch (error) {
    return mapRepoLinkError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { workspaceId } = await context.params;
  const json = await request.json().catch(() => null);
  const parsed = connectRepoRequestSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(
      parsed.error.issues[0]?.message ?? "Invalid connect-repo payload."
    );
  }

  try {
    const repoLink = await connectRepoToWorkspace({
      userId,
      workspaceId,
      owner: parsed.data.owner,
      name: parsed.data.name,
    });
    return NextResponse.json({ repoLink }, { status: 201 });
  } catch (error) {
    return mapRepoLinkError(error);
  }
}

function mapRepoLinkError(error: unknown) {
  if (error instanceof RepoLinkError) {
    const status = STATUS_BY_CODE[error.code] ?? 400;
    return jsonError(error.message, status);
  }
  console.error("Repo link error", error);
  return jsonError("Unexpected error while linking repository.", 500);
}

const STATUS_BY_CODE: Record<string, number> = {
  workspace_not_found: 404,
  github_not_connected: 409,
  github_access_denied: 401,
  repo_not_found: 404,
  already_linked: 409,
};
