import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { getUserContext } from "@/lib/services/auth-service";
import { jsonError } from "@/lib/utils/http";

export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const user = await getUserContext(userId);

  if (!user) {
    return jsonError("User not found.", 404);
  }

  return NextResponse.json(user);
}
