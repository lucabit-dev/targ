import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { GithubApiError, listUserRepos } from "@/lib/github/client";
import { getDecryptedAccessToken } from "@/lib/services/github-account-service";
import { jsonError } from "@/lib/utils/http";

/// Returns the current user's GitHub repos (via their stored OAuth token) for
/// the workspace repo picker. Lightweight projection to avoid leaking fields
/// the UI doesn't need.
export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const token = await getDecryptedAccessToken(userId);
  if (!token) {
    return jsonError("GitHub is not connected for this user.", 409);
  }

  const url = new URL(request.url);
  const perPage = clampNumber(url.searchParams.get("perPage"), 50, 1, 100);
  const page = clampNumber(url.searchParams.get("page"), 1, 1, 20);
  const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";

  try {
    const repos = await listUserRepos(token, { perPage, page });
    const filtered = query
      ? repos.filter(
          (repo) =>
            repo.fullName.toLowerCase().includes(query) ||
            (repo.description ?? "").toLowerCase().includes(query)
        )
      : repos;

    return NextResponse.json({
      repos: filtered.map((repo) => ({
        id: repo.id,
        fullName: repo.fullName,
        owner: repo.owner,
        name: repo.name,
        description: repo.description,
        visibility: repo.visibility,
        defaultBranch: repo.defaultBranch,
        htmlUrl: repo.htmlUrl,
        pushedAt: repo.pushedAt,
        archived: repo.archived,
        permissions: repo.permissions,
      })),
    });
  } catch (error) {
    if (error instanceof GithubApiError) {
      if (error.status === 401 || error.status === 403) {
        return jsonError(
          "GitHub rejected the stored token. Reconnect GitHub and try again.",
          401
        );
      }
      return jsonError(error.message, error.status >= 400 ? error.status : 502);
    }
    return jsonError("Failed to fetch repos from GitHub.", 502);
  }
}

function clampNumber(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
