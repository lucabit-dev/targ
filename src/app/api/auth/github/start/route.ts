import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import {
  GITHUB_AUTHORIZE_URL,
  getGithubOAuthConfig,
} from "@/lib/github/oauth-config";
import {
  GITHUB_OAUTH_STATE_COOKIE,
  GITHUB_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/github/oauth-state";
import { jsonError } from "@/lib/utils/http";

/// Kicks off the GitHub OAuth dance. The client should hit this via a plain
/// `<a href>` (or a full-page redirect) so the browser follows the 302 to
/// github.com. Returning HTML is not required — we just redirect.
export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const configResult = getGithubOAuthConfig();
  if (!configResult.configured) {
    return jsonError(
      `GitHub OAuth is not configured. Missing: ${configResult.missing.join(", ")}.`,
      503
    );
  }
  const { clientId, callbackUrl, scopes } = configResult.config;

  const url = new URL(request.url);
  const returnTo = sanitiseReturnTo(url.searchParams.get("returnTo"));
  const stateSecret = randomBytes(24).toString("base64url");
  const state = JSON.stringify({ s: stateSecret, u: userId, r: returnTo });
  const stateEncoded = Buffer.from(state, "utf8").toString("base64url");

  const cookieStore = await cookies();
  cookieStore.set(GITHUB_OAUTH_STATE_COOKIE, stateSecret, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GITHUB_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
  });

  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizeUrl.searchParams.set("scope", scopes.join(" "));
  authorizeUrl.searchParams.set("state", stateEncoded);
  authorizeUrl.searchParams.set("allow_signup", "false");

  return NextResponse.redirect(authorizeUrl.toString(), { status: 302 });
}

function sanitiseReturnTo(value: string | null): string {
  // Only accept same-origin relative paths to avoid open-redirect bugs.
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/workspace";
  }
  if (value.length > 200) return "/workspace";
  return value;
}
