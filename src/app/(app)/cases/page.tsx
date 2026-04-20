import { CasesScreen } from "@/components/cases-screen";
import type { CaseListItem } from "@/components/cases-list";
import { getCaseListStatusLabel } from "@/lib/case-list-status";
import { requireCurrentUser } from "@/lib/auth/server";
import { listCasesForUser } from "@/lib/services/case-service";

export default async function CasesPage() {
  const currentUser = await requireCurrentUser();
  const cases = await listCasesForUser(currentUser.user.id);
  const caseItems: CaseListItem[] = cases.map(
    ({ _count, repoLink, ...rest }) => ({
      ...rest,
      evidenceCount: _count.evidence,
      statusLabel: getCaseListStatusLabel(rest),
      repoFullName: repoLink
        ? `${repoLink.ownerLogin}/${repoLink.repoName}`
        : null,
    })
  );

  return <CasesScreen cases={caseItems} />;
}
