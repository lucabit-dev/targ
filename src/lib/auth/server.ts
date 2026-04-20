import { redirect } from "next/navigation";

import { getSessionUserId } from "@/lib/auth/session";
import { getUserContext } from "@/lib/services/auth-service";

export async function getOptionalCurrentUser() {
  const userId = await getSessionUserId();

  if (!userId) {
    return null;
  }

  return getUserContext(userId);
}

export async function requireCurrentUser() {
  const user = await getOptionalCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

export async function redirectIfAuthenticated() {
  const user = await getOptionalCurrentUser();

  if (user) {
    redirect("/");
  }
}
