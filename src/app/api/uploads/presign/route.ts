import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { reserveUploadForCase } from "@/lib/services/evidence-service";
import { jsonError } from "@/lib/utils/http";
import { presignUploadInputSchema } from "@/lib/validators";

export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const json = await request.json().catch(() => null);
  const parsed = presignUploadInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid upload payload.");
  }

  try {
    const upload = await reserveUploadForCase(userId, parsed.data);
    return NextResponse.json(upload);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not reserve upload.",
      400
    );
  }
}
