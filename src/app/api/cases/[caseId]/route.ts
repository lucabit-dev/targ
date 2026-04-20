import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import {
  CaseServiceError,
  getCaseForUser,
  setCaseRepoLinkForUser,
  updateCaseSolveModeForUser,
} from "@/lib/services/case-service";
import { prismaSolveModeMap } from "@/lib/planning/intake-preferences";
import { patchCaseSchema } from "@/lib/validators";
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
  const parsed = patchCaseSchema.safeParse(body);

  if (!parsed.success) {
    return jsonError("Invalid patch body.", 400);
  }

  // Branch on which union variant the body matched. The zod schema is a
  // .strict() union so we know exactly one field is present.
  if ("solveMode" in parsed.data) {
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

  // repoLinkId variant. `repoLinkId: null` explicitly clears the scope.
  try {
    const result = await setCaseRepoLinkForUser({
      userId,
      caseId,
      repoLinkId: parsed.data.repoLinkId,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CaseServiceError) {
      return jsonError(error.message, error.status);
    }
    throw error;
  }
}
