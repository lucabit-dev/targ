/// Cookie that carries the OAuth state secret between `/api/auth/github/start`
/// and `/api/auth/github/callback`. The actual state value embedded in the
/// GitHub redirect is base64url({ s: secret, u: userId, r: returnTo }); this
/// cookie stores just `s` so we can compare on callback.
export const GITHUB_OAUTH_STATE_COOKIE = "targ_gh_oauth_state";
export const GITHUB_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
