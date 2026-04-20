import Link from "next/link";
import { notFound } from "next/navigation";

import { CaseViewShell } from "@/components/case-view-shell";
import { requireCurrentUser } from "@/lib/auth/server";
import {
  getLatestAnalysisRunForCase,
  getLatestDiagnosisForCase,
  listDiagnosisSnapshotsForCase,
} from "@/lib/services/analysis-service";
import { getCaseForUser } from "@/lib/services/case-service";
import { getLatestDraftForCase } from "@/lib/services/draft-service";
import { listEvidenceForCase } from "@/lib/services/evidence-service";
import { getPlanningArtifactsForCase } from "@/lib/services/planning-service";

type CasePageProps = {
  params: Promise<{
    caseId: string;
  }>;
};

export default async function CasePage({ params }: CasePageProps) {
  const currentUser = await requireCurrentUser();
  const { caseId } = await params;
  const currentCase = await getCaseForUser(currentUser.user.id, caseId);

  if (!currentCase) {
    notFound();
  }

  const evidence = await listEvidenceForCase(currentUser.user.id, caseId);
  const latestRun = await getLatestAnalysisRunForCase(currentUser.user.id, caseId);
  const latestDiagnosis = await getLatestDiagnosisForCase(
    currentUser.user.id,
    caseId
  );
  const diagnosisHistory = await listDiagnosisSnapshotsForCase(
    currentUser.user.id,
    caseId
  );
  const latestDraft = await getLatestDraftForCase(currentUser.user.id, caseId);
  const planningArtifacts = await getPlanningArtifactsForCase(
    currentUser.user.id,
    caseId
  );

  return (
    <div className="mx-auto w-full max-w-[72rem] xl:max-w-[80rem]">
      <div className="mb-5">
        <Link
          href="/cases"
          className="targ-meta text-[var(--color-text-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-text-primary)]"
        >
          ← Cases
        </Link>
      </div>

      <CaseViewShell
        caseId={caseId}
        caseTitle={currentCase.title}
        caseProblemStatement={currentCase.userProblemStatement}
        caseProblemLens={currentCase.problemLens}
        caseUpdatedAt={currentCase.updatedAt}
        caseWorkflowState={currentCase.workflowState}
        caseAnalysisState={currentCase.analysisState}
        caseDraftState={currentCase.draftState}
        caseConfidence={currentCase.confidence}
        initialEvidence={evidence}
        initialRun={latestRun}
        initialDiagnosis={latestDiagnosis}
        diagnosisHistory={diagnosisHistory}
        initialDraft={latestDraft.draft}
        initialDraftReason={latestDraft.reason}
        initialSolveMode={currentCase.solveMode}
        initialBreakdown={planningArtifacts?.breakdown ?? null}
        initialWorkBundle={planningArtifacts?.workBundle ?? null}
      />
    </div>
  );
}
