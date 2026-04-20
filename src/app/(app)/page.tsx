import { HomeCaseComposer } from "@/components/home-case-composer";
import { requireCurrentUser } from "@/lib/auth/server";
import { getWorkspaceForUser } from "@/lib/services/workspace-service";

export default async function HomePage() {
  const currentUser = await requireCurrentUser();
  const workspaceId =
    currentUser.currentWorkspace?.id ?? currentUser.workspaces[0]?.id ?? "";
  const workspace = workspaceId
    ? await getWorkspaceForUser(currentUser.user.id, workspaceId)
    : null;

  return (
    <div className="-mx-4 -my-6 flex min-h-0 flex-1 flex-col px-4 py-4 sm:-mx-6 sm:px-6 lg:-mx-10 lg:-my-9 lg:px-8 lg:py-5">
      <section className="flex min-h-0 w-full flex-1 flex-col">
        <HomeCaseComposer
          workspaceId={workspaceId}
          initialWorkspacePlaybook={workspace?.playbook ?? null}
        />
      </section>
    </div>
  );
}
