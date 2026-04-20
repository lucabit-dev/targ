import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import { loadGoldenDataset } from "@/lib/evals/dataset";
import {
  buildAggregateScorecard,
  evaluateCaseRun,
  type CaseEvaluationResult,
} from "@/lib/evals/scorecard";
import { runEvidenceJobs } from "@/lib/jobs/evidence-jobs";
import { readRunTrace, recordTraceGraderResult } from "@/lib/observability/run-trace";
import { signupUser } from "@/lib/services/auth-service";
import {
  answerAnalysisRunQuestion,
  getAnalysisRunForUser,
  getLatestDiagnosisForCase,
  processAnalysisRun,
  startAnalysisRunForCase,
} from "@/lib/services/analysis-service";
import { createCaseForUser } from "@/lib/services/case-service";
import { getLatestDraftForCase } from "@/lib/services/draft-service";
import { createTextEvidenceForCase } from "@/lib/services/evidence-service";

const EVAL_OUTPUT_ROOT = path.join(process.cwd(), "storage", "evals");

async function ensureEvalOutputRoot() {
  await mkdir(EVAL_OUTPUT_ROOT, { recursive: true });
}

async function seedCaseFromGolden(params: {
  goldenCase: Awaited<ReturnType<typeof loadGoldenDataset>>["seededCases"][number];
  runLabel: string;
}) {
  const { goldenCase, runLabel } = params;
  const email = `${goldenCase.id}.${runLabel}@eval.targ.local`;
  const { user } = await signupUser({
    name: `Eval ${goldenCase.id}`,
    email,
    password: "password123",
  });

  const createdCase = await createCaseForUser(user.id, {
    userProblemStatement: goldenCase.userProblemStatement,
    title: goldenCase.title,
  });

  if (goldenCase.severity) {
    await prisma.targCase.update({
      where: {
        id: createdCase.id,
      },
      data: {
        severity: goldenCase.severity,
      },
    });
  }

  for (const evidence of goldenCase.evidence) {
    if (evidence.kind === "screenshot") {
      throw new Error(
        `Golden case ${goldenCase.id} uses screenshot evidence, which is not yet supported by the eval seeding helper.`
      );
    }

    const createdEvidence = await createTextEvidenceForCase(user.id, createdCase.id, {
      kind: evidence.kind,
      source: evidence.source,
      originalName: evidence.originalName,
      rawText: evidence.rawText,
    });

    await runEvidenceJobs(createdEvidence.id, createdCase.id);
  }

  return {
    userId: user.id,
    caseId: createdCase.id,
  };
}

async function runGoldenCase(params: {
  goldenCase: Awaited<ReturnType<typeof loadGoldenDataset>>["seededCases"][number];
  runLabel: string;
}) {
  const seeded = await seedCaseFromGolden({
    goldenCase: params.goldenCase,
    runLabel: params.runLabel,
  });

  const started = await startAnalysisRunForCase(
    seeded.userId,
    seeded.caseId,
    "golden_eval"
  );
  const startedRun = started.run;

  await processAnalysisRun(startedRun.id);

  let currentRun = await getAnalysisRunForUser(seeded.userId, startedRun.id);
  let answerIndex = 0;

  while (currentRun?.status === "needs_input" && answerIndex < params.goldenCase.clarifyingAnswers.length) {
    await answerAnalysisRunQuestion(seeded.userId, startedRun.id, {
      answer: params.goldenCase.clarifyingAnswers[answerIndex],
    });
    answerIndex += 1;
    await processAnalysisRun(startedRun.id);
    currentRun = await getAnalysisRunForUser(seeded.userId, startedRun.id);
  }

  const diagnosis = await getLatestDiagnosisForCase(seeded.userId, seeded.caseId);
  const draftResponse = await getLatestDraftForCase(seeded.userId, seeded.caseId);
  const trace = await readRunTrace(startedRun.id);

  const evaluation = evaluateCaseRun({
    goldenCase: params.goldenCase,
    trace,
    diagnosis,
    draft: draftResponse.draft,
  });

  await recordTraceGraderResult(startedRun.id, evaluation as unknown as Record<string, unknown>);

  return {
    runId: startedRun.id,
    caseId: seeded.caseId,
    evaluation,
    diagnosis,
    draft: draftResponse.draft,
  };
}

function buildMarkdownReport(params: {
  scorecard: ReturnType<typeof buildAggregateScorecard>;
  caseResults: Array<{
    runId: string;
    evaluation: CaseEvaluationResult;
  }>;
  dataset: Awaited<ReturnType<typeof loadGoldenDataset>>;
}) {
  const { scorecard, caseResults, dataset } = params;

  return [
    "# Targ Eval Scorecard",
    "",
    `Seeded cases run: ${dataset.seededCases.length}`,
    `Golden target scaffold: ${dataset.targetCount}`,
    `Scaffold placeholders remaining: ${dataset.scaffoldCount}`,
    "",
    "## Summary",
    "",
    `- Pass: ${scorecard.passCount}`,
    `- Fail: ${scorecard.failCount}`,
    "",
    "## Dimension Averages",
    "",
    ...Object.entries(scorecard.averages).map(
      ([key, value]) => `- ${key}: ${value.toFixed(2)}`
    ),
    "",
    "## Hard Fails",
    "",
    ...(Object.keys(scorecard.hardFailCounts).length > 0
      ? Object.entries(scorecard.hardFailCounts).map(
          ([key, value]) => `- ${key}: ${value}`
        )
      : ["- none"]),
    "",
    "## Top Weaknesses",
    "",
    ...(scorecard.topWeaknesses.length > 0
      ? scorecard.topWeaknesses.map(
          (item) => `- ${item.dimension}: ${item.count}`
        )
      : ["- none"]),
    "",
    "## Per Case",
    "",
    ...caseResults.flatMap((result) => [
      `### ${result.evaluation.caseId}`,
      `- runId: ${result.runId}`,
      `- pass: ${result.evaluation.pass}`,
      `- hardFails: ${
        result.evaluation.hardFails.length > 0
          ? result.evaluation.hardFails.join(", ")
          : "none"
      }`,
      `- weaknesses: ${
        result.evaluation.weaknessDimensions.length > 0
          ? result.evaluation.weaknessDimensions.join(", ")
          : "none"
      }`,
      "",
    ]),
  ].join("\n");
}

async function main() {
  await ensureEvalOutputRoot();
  const dataset = await loadGoldenDataset();
  const runLabel = Date.now().toString();
  const caseResults: Array<{
    runId: string;
    evaluation: CaseEvaluationResult;
  }> = [];

  for (const goldenCase of dataset.seededCases) {
    const result = await runGoldenCase({
      goldenCase,
      runLabel,
    });

    caseResults.push({
      runId: result.runId,
      evaluation: result.evaluation,
    });
  }

  const scorecard = buildAggregateScorecard(
    caseResults.map((item) => item.evaluation)
  );

  const output = {
    generatedAt: new Date().toISOString(),
    dataset: {
      seededCount: dataset.seededCases.length,
      targetCount: dataset.targetCount,
      scaffoldCount: dataset.scaffoldCount,
    },
    scorecard,
    caseResults,
  };

  const jsonPath = path.join(EVAL_OUTPUT_ROOT, `${runLabel}-results.json`);
  const mdPath = path.join(EVAL_OUTPUT_ROOT, `${runLabel}-scorecard.md`);

  await writeFile(jsonPath, JSON.stringify(output, null, 2));
  await writeFile(
    mdPath,
    buildMarkdownReport({
      scorecard,
      caseResults,
      dataset,
    })
  );

  console.log(`Wrote eval results to ${jsonPath}`);
  console.log(`Wrote scorecard to ${mdPath}`);
  console.log(
    `Pass ${scorecard.passCount}/${scorecard.totalCases}, fail ${scorecard.failCount}/${scorecard.totalCases}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
