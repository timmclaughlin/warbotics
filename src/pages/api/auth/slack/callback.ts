import type { APIRoute } from "astro";
import { exchangeCode, fetchUserInfo } from "~/lib/slack";
import {
  newSessionId,
  saveSession,
  sessionCookieHeader,
  signSessionCookie,
  type SessionData,
} from "~/lib/session";
import { searchClientFromEnv, userInstanceId } from "~/lib/search";

export const prerender = false;

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export const GET: APIRoute = async ({ locals, url, request }) => {
  const env = locals.runtime.env as Env;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const storedState = readCookie(request.headers.get("cookie"), "wb_oauth_state");
  const [stateRandom, encodedReturnTo] = state.split(".");
  if (!storedState || storedState !== stateRandom) {
    return new Response("Invalid OAuth state", { status: 400 });
  }
  let returnTo = "/";
  try {
    if (encodedReturnTo) returnTo = atob(encodedReturnTo);
  } catch {
    // fall through with default
  }

  const token = await exchangeCode({
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    code,
    redirectUri: env.SLACK_REDIRECT_URI,
  });
  if (!token.ok || !token.access_token) {
    return new Response(`Slack token exchange failed: ${token.error ?? "unknown"}`, {
      status: 400,
    });
  }

  const info = await fetchUserInfo(token.access_token);
  if (!info.ok) {
    return new Response(`Slack userinfo failed: ${info.error ?? "unknown"}`, {
      status: 400,
    });
  }

  const slackUserId = info["https://slack.com/user_id"];
  const slackTeamId = info["https://slack.com/team_id"];
  if (env.SLACK_TEAM_ID && slackTeamId !== env.SLACK_TEAM_ID) {
    return new Response("This workspace is not authorized to access Warbotics", {
      status: 403,
    });
  }

  // Ensure a per-user AI Search instance exists. First login creates it; later
  // logins are a no-op because ensureInstance swallows the "already exists" conflict.
  const instanceId = userInstanceId(slackUserId);
  try {
    const search = searchClientFromEnv(env);
    await search.ensureInstance(instanceId, {
      indexMethod: { keyword: true, vector: true },
    });
  } catch (err) {
    console.error("Failed to ensure user AI Search instance", err);
    // Don't block login — user can still browse public content and shared search.
  }

  const sessionId = newSessionId();
  const session: SessionData = {
    slackUserId,
    slackTeamId,
    name: info.name,
    email: info.email,
    avatar: info.picture,
    aiSearchInstanceId: instanceId,
    createdAt: Date.now(),
  };
  await saveSession(env.SESSIONS, sessionId, session);

  const jwt = await signSessionCookie(sessionId, env.SESSION_SECRET);
  const headers = new Headers();
  headers.append("Location", returnTo);
  headers.append("Set-Cookie", sessionCookieHeader(jwt));
  headers.append(
    "Set-Cookie",
    "wb_oauth_state=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0",
  );

  return new Response(null, { status: 302, headers });
};
