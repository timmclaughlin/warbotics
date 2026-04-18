import type { APIRoute } from "astro";
import { buildAuthorizeUrl } from "~/lib/slack";

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  const env = locals.runtime.env as Env;
  if (!env.SLACK_CLIENT_ID || !env.SLACK_REDIRECT_URI) {
    return new Response("Slack OAuth is not configured", { status: 500 });
  }

  const returnTo = url.searchParams.get("returnTo") ?? "/";
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const stateRandom = Array.from(stateBytes, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  // Encode returnTo into state so the callback can bounce the user back.
  const state = `${stateRandom}.${btoa(returnTo)}`;

  // Intentionally omit `team` from the authorize URL: Slack rejects it for
  // non-distributed apps (invalid_team_for_non_distributed_app). We still
  // enforce the team match in the callback via SLACK_TEAM_ID.
  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.SLACK_CLIENT_ID,
    redirectUri: env.SLACK_REDIRECT_URI,
    state,
  });

  const cookie = [
    `wb_oauth_state=${stateRandom}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Secure",
    "Max-Age=600",
  ].join("; ");

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl, "Set-Cookie": cookie },
  });
};
