import { prisma } from "@/lib/prisma";
import { decryptToken, encryptToken } from "@/lib/crypto/token-cipher";
import type { GithubOAuthTokenResponse } from "@/lib/github/client";
import { getAuthenticatedUser } from "@/lib/github/client";

export type GithubAccountSummary = {
  id: string;
  githubUserId: number;
  githubLogin: string;
  avatarUrl: string | null;
  scope: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toSummary(row: {
  id: string;
  githubUserId: number;
  githubLogin: string;
  avatarUrl: string | null;
  scope: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): GithubAccountSummary {
  return {
    id: row.id,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    avatarUrl: row.avatarUrl,
    scope: row.scope,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/// Persist an OAuth token + GitHub identity for the given TARG user. This is
/// an upsert so repeated "Connect GitHub" clicks just refresh the token.
export async function upsertGithubAccountFromToken(params: {
  userId: string;
  tokenResponse: GithubOAuthTokenResponse;
}): Promise<GithubAccountSummary> {
  const { userId, tokenResponse } = params;

  const githubUser = await getAuthenticatedUser(tokenResponse.accessToken);
  const accessTokenEnc = encryptToken(tokenResponse.accessToken);
  const refreshTokenEnc = tokenResponse.refreshToken
    ? encryptToken(tokenResponse.refreshToken)
    : null;

  const row = await prisma.targGithubAccount.upsert({
    where: { userId },
    create: {
      userId,
      githubUserId: githubUser.id,
      githubLogin: githubUser.login,
      avatarUrl: githubUser.avatar_url,
      accessTokenEnc,
      refreshTokenEnc,
      expiresAt: tokenResponse.expiresAt,
      scope: tokenResponse.scope,
    },
    update: {
      githubUserId: githubUser.id,
      githubLogin: githubUser.login,
      avatarUrl: githubUser.avatar_url,
      accessTokenEnc,
      refreshTokenEnc,
      expiresAt: tokenResponse.expiresAt,
      scope: tokenResponse.scope,
    },
    select: {
      id: true,
      githubUserId: true,
      githubLogin: true,
      avatarUrl: true,
      scope: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return toSummary(row);
}

export async function getGithubAccountSummary(
  userId: string
): Promise<GithubAccountSummary | null> {
  const row = await prisma.targGithubAccount.findUnique({
    where: { userId },
    select: {
      id: true,
      githubUserId: true,
      githubLogin: true,
      avatarUrl: true,
      scope: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return row ? toSummary(row) : null;
}

/// Load + decrypt the raw access token for the given user. Returns null when
/// no account is connected. Callers are responsible for handling failed
/// GitHub API calls (e.g. revoked tokens) by prompting the user to reconnect.
export async function getDecryptedAccessToken(
  userId: string
): Promise<string | null> {
  const row = await prisma.targGithubAccount.findUnique({
    where: { userId },
    select: { accessTokenEnc: true },
  });
  if (!row) return null;
  return decryptToken(row.accessTokenEnc);
}

export async function deleteGithubAccount(userId: string): Promise<void> {
  await prisma.targGithubAccount.deleteMany({ where: { userId } });
}
