import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { updateWorkspacePlaybookForUser } from "@/lib/services/workspace-service";
import { jsonError } from "@/lib/utils/http";
import { updateWorkspacePlaybookInputSchema } from "@/lib/validators";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const json = await request.json().catch(() => null);
  const parsed = updateWorkspacePlaybookInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(
      parsed.error.issues[0]?.message ?? "Invalid workspace playbook payload."
    );
  }

  const { workspaceId } = await context.params;

  try {
    const workspace = await updateWorkspacePlaybookForUser(
      userId,
      workspaceId,
      parsed.data
    );

    return NextResponse.json({ workspace });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not update workspace playbook.",
      400
    );
  }
}
