import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { deleteGithubAccount } from "@/lib/services/github-account-service";
import { jsonError } from "@/lib/utils/http";

export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  await deleteGithubAccount(userId);
  return NextResponse.json({ ok: true });
}
