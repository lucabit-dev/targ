import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import {
  createHandoffPacket,
  HandoffError,
  listHandoffsForCase,
} from "@/lib/services/handoff-service";
import { jsonError } from "@/lib/utils/http";
import { createHandoffInputSchema } from "@/lib/validators";

type RouteContext = {
  params: Promise<{
    caseId: string;
  }>;
};

/**
 * Resolve the absolute origin of the current request so the generated packet's
 * `meta.caseUrl` is always absolute (spec §9, invariant 7). Honours
 * `x-forwarded-*` headers when TARG is deployed behind a proxy.
 */
function resolveRequestOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = forwardedHost ?? request.headers.get("host");
  const proto =
    forwardedProto ??
    (request.nextUrl.protocol ? request.nextUrl.protocol.replace(/:$/, "") : "http");
  if (host) {
    return `${proto}://${host}`;
  }
  return request.nextUrl.origin;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { caseId } = await context.params;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const parsed = createHandoffInputSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
  }

  try {
    const result = await createHandoffPacket({
      userId,
      caseId,
      target: parsed.data.target,
      diagnosisId: parsed.data.diagnosisId,
      workBundleId: parsed.data.workBundleId,
      requestOrigin: resolveRequestOrigin(request),
    });
    return NextResponse.json({ handoff: result }, { status: 201 });
  } catch (error) {
    if (error instanceof HandoffError) {
      return jsonError(error.message, error.status);
    }
    return jsonError(
      error instanceof Error ? error.message : "Could not build handoff packet.",
      500
    );
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const { caseId } = await context.params;

  try {
    const handoffs = await listHandoffsForCase(userId, caseId);
    return NextResponse.json({ handoffs });
  } catch (error) {
    if (error instanceof HandoffError) {
      return jsonError(error.message, error.status);
    }
    return jsonError(
      error instanceof Error ? error.message : "Could not list handoffs.",
      500
    );
  }
}
