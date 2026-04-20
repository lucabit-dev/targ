import { AppShell } from "@/components/app-shell";
import { requireCurrentUser } from "@/lib/auth/server";

export default async function ProtectedAppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const currentUser = await requireCurrentUser();

  return (
    <AppShell
      user={currentUser.user}
      currentWorkspaceName={currentUser.currentWorkspace?.name ?? "Workspace"}
      workspaces={currentUser.workspaces}
    >
      {children}
    </AppShell>
  );
}
