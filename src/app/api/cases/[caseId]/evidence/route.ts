import { after, NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { runEvidenceJobs } from "@/lib/jobs/evidence-jobs";
import {
  createTextEvidenceForCase,
  listEvidenceForCase,
} from "@/lib/services/evidence-service";
import { jsonError } from "@/lib/utils/http";
import { createTextEvidenceInputSchema } from "@/lib/validators";

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
    const evidence = await listEvidenceForCase(userId, caseId);
    return NextResponse.json({ evidence });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load evidence.", 404);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const json = await request.json().catch(() => null);
  const parsed = createTextEvidenceInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid evidence payload.");
  }

  const { caseId } = await context.params;

  try {
    const evidence = await createTextEvidenceForCase(userId, caseId, parsed.data);

    after(async () => {
      await runEvidenceJobs(evidence.id, caseId);
    });

    return NextResponse.json({ evidence }, { status: 201 });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not create evidence.",
      400
    );
  }
}
