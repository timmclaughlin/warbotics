import { defineMiddleware } from "astro:middleware";
import {
  loadSession,
  readSessionCookie,
  verifySessionCookie,
} from "~/lib/session";
import { loadConfig } from "~/lib/settings";
import { isAdmin } from "~/lib/acl";

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

  // Populate isAdmin so the layout can decide whether to show the ⚙ nav
  // entry. Fast path for the bootstrap owner avoids the R2 round-trip; for
  // anyone else we load config.json once per request to evaluate.
  if (context.locals.user) {
    const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
    const userEmail = context.locals.user.email?.trim().toLowerCase();
    if (ownerEmail && userEmail && userEmail === ownerEmail) {
      context.locals.isAdmin = true;
    } else {
      try {
        const config = await loadConfig(env);
        context.locals.isAdmin = isAdmin(context.locals.user, config, env);
      } catch {
        context.locals.isAdmin = false;
      }
    }
  }

  // /settings is admin-only at the route level. The page also checks again
  // and the API does too — defense in depth.
  if (url.pathname === "/settings" && !context.locals.isAdmin) {
    return new Response("Forbidden — admin-only page.", { status: 403 });
  }

  return next();
});
