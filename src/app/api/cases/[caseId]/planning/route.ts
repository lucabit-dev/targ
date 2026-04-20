import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { getPlanningArtifactsForCase } from "@/lib/services/planning-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{
    caseId: string;
  }>;
};

/**
 * Latest Breakdown + Work Bundle for the case (first-class planning output).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { caseId } = await context.params;
  const planning = await getPlanningArtifactsForCase(userId, caseId);

  if (!planning) {
    return jsonError("Case not found.", 404);
  }

  return NextResponse.json(planning);
}
