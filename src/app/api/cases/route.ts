import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import {
  createCaseForUser,
  listCasesForUser,
} from "@/lib/services/case-service";
import { jsonError } from "@/lib/utils/http";
import { createCaseInputSchema } from "@/lib/validators";

export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const cases = await listCasesForUser(userId);

  return NextResponse.json({ cases });
}

export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const json = await request.json().catch(() => null);
  const parsed = createCaseInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid case payload.");
  }

  try {
    const createdCase = await createCaseForUser(userId, parsed.data);

    return NextResponse.json({ case: createdCase }, { status: 201 });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not create case.",
      400
    );
  }
}
