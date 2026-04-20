import { NextRequest, NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session";
import { getUserContext, loginUser } from "@/lib/services/auth-service";
import { jsonError } from "@/lib/utils/http";
import { loginInputSchema } from "@/lib/validators";

export async function POST(request: NextRequest) {
  const json = await request.json().catch(() => null);
  const parsed = loginInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid login data.");
  }

  const user = await loginUser(parsed.data);

  if (!user) {
    return jsonError("Invalid email or password.", 401);
  }

  await setSessionCookie(user.id);

  const me = await getUserContext(user.id);

  return NextResponse.json({ user: me });
}
