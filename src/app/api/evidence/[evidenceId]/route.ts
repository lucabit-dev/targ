import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { getEvidenceForUser } from "@/lib/services/evidence-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{
    evidenceId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { evidenceId } = await context.params;
  const evidence = await getEvidenceForUser(userId, evidenceId);

  if (!evidence) {
    return jsonError("Evidence not found.", 404);
  }

  return NextResponse.json({ evidence });
}
