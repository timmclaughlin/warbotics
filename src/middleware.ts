import { defineMiddleware } from "astro:middleware";
import {
  loadSession,
  readSessionCookie,
  verifySessionCookie,
} from "~/lib/session";

// Paths that don't require authentication.
const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/api/auth/slack/authorize",
  "/api/auth/slack/callback",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/_astro/")) return true;
  if (pathname.startsWith("/favicon")) return true;
  // Public MD content is readable without auth; search + personalization require it.
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return true;
  return false;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const env = context.locals.runtime?.env as Env | undefined;
  if (!env) return next();

  const cookie = context.request.headers.get("cookie");
  const token = readSessionCookie(cookie);
  if (token) {
    const sid = await verifySessionCookie(token, env.SESSION_SECRET);
    if (sid) {
      const session = await loadSession(env.SESSIONS, sid);
      if (session) {
        context.locals.sessionId = sid;
        context.locals.user = {
          id: sid,
          slackUserId: session.slackUserId,
          slackTeamId: session.slackTeamId,
          name: session.name,
          email: session.email,
          avatar: session.avatar,
          aiSearchInstanceId: session.aiSearchInstanceId,
        };
      }
    }
  }

  const url = new URL(context.request.url);
  if (!context.locals.user && !isPublic(url.pathname)) {
    const returnTo = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(`${url.origin}/login?returnTo=${returnTo}`, 302);
  }

  return next();
});
