// Slack "Sign in with Slack" (OpenID Connect) helpers.
// Docs: https://api.slack.com/authentication/sign-in-with-slack

const AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
const TOKEN_URL = "https://slack.com/api/openid.connect.token";
const USERINFO_URL = "https://slack.com/api/openid.connect.userInfo";

export const SLACK_SCOPES = ["openid", "profile", "email"].join(" ");

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  teamId?: string;
  nonce?: string;
}): string {
  const qs = new URLSearchParams({
    response_type: "code",
    scope: SLACK_SCOPES,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
  });
  if (params.teamId) qs.set("team", params.teamId);
  if (params.nonce) qs.set("nonce", params.nonce);
  return `${AUTHORIZE_URL}?${qs.toString()}`;
}

export interface SlackTokenResponse {
  ok: boolean;
  access_token?: string;
  id_token?: string;
  error?: string;
}

export async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<SlackTokenResponse> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return (await res.json()) as SlackTokenResponse;
}

export interface SlackUserInfo {
  ok: boolean;
  sub: string;
  "https://slack.com/user_id": string;
  "https://slack.com/team_id": string;
  name: string;
  email?: string;
  picture?: string;
  error?: string;
}

export async function fetchUserInfo(accessToken: string): Promise<SlackUserInfo> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (await res.json()) as SlackUserInfo;
}
