import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import {
  getCaseForUser,
  updateCaseSolveModeForUser,
} from "@/lib/services/case-service";
import { prismaSolveModeMap } from "@/lib/planning/intake-preferences";
import { patchCaseSolveModeSchema } from "@/lib/validators";
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
  const currentCase = await getCaseForUser(userId, caseId);

  if (!currentCase) {
    return jsonError("Case not found.", 404);
  }

  return NextResponse.json({ case: currentCase });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { caseId } = await context.params;
  const body: unknown = await request.json().catch(() => null);
  const parsed = patchCaseSolveModeSchema.safeParse(body);

  if (!parsed.success) {
    return jsonError("Invalid solve mode.", 400);
  }

  const prismaMode = prismaSolveModeMap[parsed.data.solveMode];
  const updated = await updateCaseSolveModeForUser(
    userId,
    caseId,
    prismaMode
  );

  if (!updated) {
    return jsonError("Case not found.", 404);
  }

  return NextResponse.json({
    solveMode: parsed.data.solveMode,
  });
}
