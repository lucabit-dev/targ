import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { getAnalysisRunForUser } from "@/lib/services/analysis-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{
    runId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { runId } = await context.params;
  const run = await getAnalysisRunForUser(userId, runId);

  if (!run) {
    return jsonError("Run not found.", 404);
  }

  return NextResponse.json({ run });
}
