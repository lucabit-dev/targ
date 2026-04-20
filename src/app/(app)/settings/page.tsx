import { requireCurrentUser } from "@/lib/auth/server";
import {
  AdminItem,
  AdminPage,
  AdminSection,
} from "@/components/ui/admin-surface";
import { SettingsActions } from "@/components/settings-actions";
import { formatRelativeDate } from "@/lib/utils/format";

export default async function SettingsPage() {
  const currentUser = await requireCurrentUser();

  return (
    <AdminPage
      eyebrow="Account"
      title="Settings"
      description="Profile, session, and defaults for this device. Lower priority than cases, but the place to manage access and sign out."
    >
      <AdminSection
        title="Profile"
        description="How you appear and sign in."
      >
        <AdminItem
          label="Name"
          value={currentUser.user.name ?? "Not set"}
          hint="Shown in the app shell. You can change this when profile editing ships."
        />
        <AdminItem
          label="Email"
          value={currentUser.user.email}
          hint="Used to sign in. Contact support to change email."
        />
        <AdminItem
          label="Account opened"
          value={formatRelativeDate(currentUser.user.createdAt)}
        />
      </AdminSection>

      <AdminSection
        title="Preferences"
        description="How Targ presents itself on this device."
      >
        <AdminItem
          label="Appearance"
          value="Graphite (dark)"
          hint="Tuned for long reading sessions and case review."
        />
        <AdminItem
          label="Default workspace"
          value={currentUser.currentWorkspace?.name ?? "Personal workspace"}
          hint="New cases use this workspace from Home and Cases."
        />
        <AdminItem
          label="Language"
          value="English"
          hint="Additional locales will appear here when available."
        />
      </AdminSection>

      <AdminSection
        title="Security"
        description="Access to your account."
      >
        <AdminItem
          label="Sign-in"
          value="Email and password"
        />
        <AdminItem
          label="Session"
          value="Browser cookie"
          hint="Signing out clears it. Use a private window on shared machines."
        />
        <AdminItem
          label="Password"
          value="Change in a future update"
          hint="Password reset and change flows are not exposed in this build."
        />
      </AdminSection>

      <AdminSection
        title="Session actions"
        description="Leave this device cleanly when you are done."
      >
        <SettingsActions />
      </AdminSection>

      <AdminSection
        title="Billing"
        description="Plans and invoices when Targ offers paid tiers."
      >
        <AdminItem
          label="Plan"
          value="Early access"
          hint="No charges while in standalone preview. Billing controls will live here."
        />
        <AdminItem
          label="Payment method"
          value="—"
          hint="Add a card when plans launch."
        />
      </AdminSection>
    </AdminPage>
  );
}
