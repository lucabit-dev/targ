import { requireCurrentUser } from "@/lib/auth/server";
import {
  AdminGroupLabel,
  AdminItem,
  AdminPage,
  AdminSection,
} from "@/components/ui/admin-surface";
import { WorkspaceRepoConnections } from "@/components/workspace-repo-connections";
import { getWorkspaceForUser } from "@/lib/services/workspace-service";
import { formatRelativeDate } from "@/lib/utils/format";
import { workspacePlaybookSummary } from "@/lib/workspace/playbook";

type WorkspacePageSearchParams = Promise<{
  github_connected?: string;
  github_error?: string;
}>;

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams?: WorkspacePageSearchParams;
}) {
  const currentUser = await requireCurrentUser();
  const workspace = currentUser.currentWorkspace;
  const workspaceDetails =
    workspace
      ? await getWorkspaceForUser(currentUser.user.id, workspace.id)
      : null;
  const playbookSummary = workspaceDetails?.playbook
    ? workspacePlaybookSummary(workspaceDetails.playbook)
    : null;

  const resolvedParams = searchParams ? await searchParams : undefined;
  const githubConnectedHint = resolvedParams?.github_connected === "1";
  const githubErrorHint = resolvedParams?.github_error ?? null;

  return (
    <AdminPage
      eyebrow="Workspace"
      title={workspace?.name ?? "Workspace"}
      description="Reference context for this workspace: who is here, what is connected, and what metadata shapes new cases. Secondary to live casework."
    >
      <AdminSection
        title="Members"
        description="Who can see cases and evidence in this workspace."
      >
        <AdminItem
          label="You"
          value={currentUser.user.name ?? currentUser.user.email}
          hint={currentUser.user.email}
        />
        <AdminItem
          label="Role"
          value="Owner"
          hint="Create and manage cases, evidence, and drafts."
        />
        <AdminItem
          label="Seat count"
          value="1"
          hint="Invites and shared workspaces are not enabled in this build."
        />
      </AdminSection>

      <AdminSection
        title="Analysis playbook"
        description="The first-run profile that shapes how Targ reads evidence and structures resulting work."
      >
        <AdminItem
          label="Status"
          value={playbookSummary ? "Configured" : "Not configured"}
          hint={
            playbookSummary
              ? "Set once during onboarding; use it to keep cases light while analysis stays team-aware."
              : "Home will ask for this on first workspace use."
          }
        />
        <AdminItem
          label="Team profile"
          value={playbookSummary?.team ?? "—"}
        />
        <AdminItem
          label="Analysis bias"
          value={playbookSummary?.analysisBias ?? "—"}
        />
        <AdminItem
          label="Output style"
          value={playbookSummary?.outputStyle ?? "—"}
        />
        <AdminItem
          label="Primary evidence"
          value={playbookSummary?.evidenceProfile ?? "—"}
        />
        <AdminItem
          label="Outcome destination"
          value={playbookSummary?.outcomeDestination ?? "—"}
        />
      </AdminSection>

      <AdminSection
        title="Code repositories"
        description="Link a GitHub repository so Handoff Packets can reference real paths, branches, and commit SHAs."
      >
        {workspace ? (
          <WorkspaceRepoConnections
            workspaceId={workspace.id}
            initialConnectedHint={githubConnectedHint}
            initialErrorHint={githubErrorHint}
          />
        ) : (
          <AdminItem
            label="Status"
            value="No workspace"
            hint="Create a workspace before connecting a repository."
          />
        )}
      </AdminSection>

      <AdminSection
        title="Other integrations"
        description="Targ is standalone-first. Links to other systems will stay optional."
      >
        <AdminGroupLabel>Bring data in</AdminGroupLabel>
        <AdminItem
          label="Log or error stream"
          value="Not connected"
          hint="Future: attach a read-only source so new evidence can land in cases automatically."
        />
        <AdminItem
          label="Issue or ticket system"
          value="Not connected"
          hint="Future: push a saved action draft out as context—still your workflow, not Targ as PM."
        />
      </AdminSection>

      <AdminSection
        title="Workspace details"
        description="Technical reference for support or your own records."
      >
        <AdminItem
          label="Display name"
          value={workspace?.name ?? "—"}
        />
        <AdminItem
          label="Kind"
          value={
            workspace?.personalForUserId
              ? "Personal workspace"
              : "Shared workspace"
          }
          hint={
            workspace?.personalForUserId
              ? "Tied to your account; created when you signed up."
              : "Membership-based workspace."
          }
        />
        <AdminItem
          label="Workspace ID"
          value={
            <span title={workspace?.id} className="break-all">
              {workspace?.id ?? "—"}
            </span>
          }
          mono
        />
        <AdminItem
          label="Created"
          value={workspace ? formatRelativeDate(workspace.createdAt) : "—"}
        />
        <AdminItem
          label="Last updated"
          value={workspace ? formatRelativeDate(workspace.updatedAt) : "—"}
        />
      </AdminSection>
    </AdminPage>
  );
}
