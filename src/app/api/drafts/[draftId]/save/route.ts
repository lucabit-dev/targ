import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { saveDraftForUser } from "@/lib/services/draft-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{
    draftId: string;
  }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { draftId } = await context.params;

  try {
    const draft = await saveDraftForUser(userId, draftId);
    return NextResponse.json({ draft });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not save draft.",
      400
    );
  }
}
