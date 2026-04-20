import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { exchangeCodeForToken } from "@/lib/github/client";
import { getGithubOAuthConfig } from "@/lib/github/oauth-config";
import { GITHUB_OAUTH_STATE_COOKIE } from "@/lib/github/oauth-state";
import { upsertGithubAccountFromToken } from "@/lib/services/github-account-service";

function buildReturnUrl(origin: string, path: string, params: Record<string, string>) {
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

function originFromRequest(request: NextRequest): string {
  const configuredAppUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (configuredAppUrl) {
    return configuredAppUrl.replace(/\/$/, "");
  }
  return new URL(request.url).origin;
}

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateEncoded = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  const cookieStore = await cookies();
  const stateCookieValue = cookieStore.get(GITHUB_OAUTH_STATE_COOKIE)?.value ?? null;
  cookieStore.delete(GITHUB_OAUTH_STATE_COOKIE);

  function failure(reason: string, returnTo = "/workspace") {
    return NextResponse.redirect(
      buildReturnUrl(origin, returnTo, { github_error: reason }),
      { status: 302 }
    );
  }

  if (errorParam) {
    return failure(errorParam);
  }
  if (!code || !stateEncoded) {
    return failure("missing_code_or_state");
  }

  const decodedState = decodeState(stateEncoded);
  if (!decodedState) {
    return failure("invalid_state_shape");
  }
  if (!stateCookieValue || stateCookieValue !== decodedState.s) {
    return failure("state_mismatch");
  }

  const sessionUserId = await getRequestUserId(request);
  if (!sessionUserId || sessionUserId !== decodedState.u) {
    return failure("session_mismatch");
  }

  const configResult = getGithubOAuthConfig();
  if (!configResult.configured) {
    return failure("oauth_not_configured");
  }

  const tokenResponse = await exchangeCodeForToken({
    code,
    clientId: configResult.config.clientId,
    clientSecret: configResult.config.clientSecret,
    redirectUri: configResult.config.callbackUrl,
  }).catch((error) => {
    console.error("GitHub token exchange failed", error);
    return null;
  });

  if (!tokenResponse) {
    return failure("token_exchange_failed", decodedState.r);
  }

  try {
    await upsertGithubAccountFromToken({
      userId: sessionUserId,
      tokenResponse,
    });
  } catch (error) {
    console.error("Failed to persist GitHub account", error);
    return failure("persist_failed", decodedState.r);
  }

  return NextResponse.redirect(
    buildReturnUrl(origin, decodedState.r, { github_connected: "1" }),
    { status: 302 }
  );
}

type DecodedState = { s: string; u: string; r: string };

function decodeState(encoded: string): DecodedState | null {
  try {
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<DecodedState>;
    if (
      typeof parsed.s === "string" &&
      typeof parsed.u === "string" &&
      typeof parsed.r === "string" &&
      parsed.r.startsWith("/")
    ) {
      return { s: parsed.s, u: parsed.u, r: parsed.r };
    }
  } catch {
    // fall through
  }
  return null;
}
