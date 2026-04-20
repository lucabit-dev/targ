import { after, NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { runAnalysisJobs } from "@/lib/jobs/analysis-jobs";
import { startAnalysisRunForCase } from "@/lib/services/analysis-service";
import { jsonError } from "@/lib/utils/http";

type RouteContext = {
  params: Promise<{
    caseId: string;
  }>;
};

export async function POST(_request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(_request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { caseId } = await context.params;

  try {
    const { run, startedNew } = await startAnalysisRunForCase(
      userId,
      caseId,
      "user_manual_analyze"
    );

    if (startedNew) {
      after(async () => {
        await runAnalysisJobs(run.id);
      });
    }

    return NextResponse.json({ run }, { status: startedNew ? 201 : 200 });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not start analysis.",
      400
    );
  }
}
