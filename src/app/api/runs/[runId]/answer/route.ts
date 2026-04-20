import { after, NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { runAnalysisJobs } from "@/lib/jobs/analysis-jobs";
import { answerAnalysisRunQuestion } from "@/lib/services/analysis-service";
import { jsonError } from "@/lib/utils/http";
import { runAnswerInputSchema } from "@/lib/validators";

type RouteContext = {
  params: Promise<{
    runId: string;
  }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const json = await request.json().catch(() => null);
  const parsed = runAnswerInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid answer payload.");
  }

  const { runId } = await context.params;

  try {
    const run = await answerAnalysisRunQuestion(userId, runId, parsed.data);

    after(async () => {
      await runAnalysisJobs(run.id);
    });

    return NextResponse.json({ run });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not save answer.",
      400
    );
  }
}
