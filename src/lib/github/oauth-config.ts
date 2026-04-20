export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

/// OAuth scopes TARG requests from GitHub.
///
/// - `read:user` lets us identify the connected account (id, login, avatar).
/// - `repo` is needed to list and read private repos. Public-only installs can
///   downgrade this to `public_repo` in a later phase if we add a toggle.
export const GITHUB_OAUTH_SCOPES = ["read:user", "repo"] as const;

export type GithubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: readonly string[];
};

export type GithubOAuthConfigResult =
  | { configured: true; config: GithubOAuthConfig }
  | { configured: false; missing: string[] };

function readAppUrl(): string {
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (raw && raw.length > 0) {
    return raw.replace(/\/$/, "");
  }
  return "http://localhost:3000";
}

export function getGithubOAuthConfig(): GithubOAuthConfigResult {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  const missing: string[] = [];
  if (!clientId) missing.push("GITHUB_OAUTH_CLIENT_ID");
  if (!clientSecret) missing.push("GITHUB_OAUTH_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return { configured: false, missing };
  }

  const callbackUrl = `${readAppUrl()}/api/auth/github/callback`;

  return {
    configured: true,
    config: {
      clientId,
      clientSecret,
      callbackUrl,
      scopes: GITHUB_OAUTH_SCOPES,
    },
  };
}

export function isGithubOAuthConfigured(): boolean {
  return getGithubOAuthConfig().configured;
}
