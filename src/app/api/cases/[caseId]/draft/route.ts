import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { getLatestDraftForCase } from "@/lib/services/draft-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{
    caseId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { caseId } = await context.params;

  try {
    const draft = await getLatestDraftForCase(userId, caseId);
    return NextResponse.json(draft);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not load draft.",
      400
    );
  }
}
