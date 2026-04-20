import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import {
  createWorkspaceForUser,
  listWorkspacesForUser,
} from "@/lib/services/workspace-service";
import { jsonError } from "@/lib/utils/http";
import { createWorkspaceInputSchema } from "@/lib/validators";

export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const workspaces = await listWorkspacesForUser(userId);

  return NextResponse.json({ workspaces });
}

export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const json = await request.json().catch(() => null);
  const parsed = createWorkspaceInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(
      parsed.error.issues[0]?.message ?? "Invalid workspace payload."
    );
  }

  const workspace = await createWorkspaceForUser(userId, parsed.data);

  return NextResponse.json({ workspace }, { status: 201 });
}
