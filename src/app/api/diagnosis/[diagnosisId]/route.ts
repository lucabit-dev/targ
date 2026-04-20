import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { getDiagnosisForUser } from "@/lib/services/analysis-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{
    diagnosisId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { diagnosisId } = await context.params;
  const diagnosis = await getDiagnosisForUser(userId, diagnosisId);

  if (!diagnosis) {
    return jsonError("Diagnosis not found.", 404);
  }

  return NextResponse.json({ diagnosis });
}
