import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import {
  getDraftForUser,
  updateDraftForUser,
} from "@/lib/services/draft-service";
import { jsonError } from "@/lib/utils/http";
import { updateDraftInputSchema } from "@/lib/validators";

type RouteContext = {
  params: Promise<{
    draftId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { draftId } = await context.params;
  const draft = await getDraftForUser(userId, draftId);

  if (!draft) {
    return jsonError("Draft not found.", 404);
  }

  return NextResponse.json({ draft });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const json = await request.json().catch(() => null);
  const parsed = updateDraftInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid draft update.");
  }

  const { draftId } = await context.params;

  try {
    const draft = await updateDraftForUser(userId, draftId, parsed.data);
    return NextResponse.json({ draft });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not update draft.",
      400
    );
  }
}
