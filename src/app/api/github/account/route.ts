import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { isGithubOAuthConfigured } from "@/lib/github/oauth-config";
import { getGithubAccountSummary } from "@/lib/services/github-account-service";
import { jsonError } from "@/lib/utils/http";

export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const [account, oauthConfigured] = await Promise.all([
    getGithubAccountSummary(userId),
    Promise.resolve(isGithubOAuthConfigured()),
  ]);

  return NextResponse.json({
    oauthConfigured,
    account,
  });
}
