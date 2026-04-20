import { NextRequest, NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session";
import { getUserContext, signupUser } from "@/lib/services/auth-service";
import { jsonError } from "@/lib/utils/http";
import { signupInputSchema } from "@/lib/validators";

export async function POST(request: NextRequest) {
  const json = await request.json().catch(() => null);
  const parsed = signupInputSchema.safeParse(json);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid signup data.");
  }

  try {
    const { user } = await signupUser(parsed.data);
    await setSessionCookie(user.id);

    const me = await getUserContext(user.id);

    return NextResponse.json({ user: me });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not create account.",
      400
    );
  }
}
