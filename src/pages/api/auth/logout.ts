import type { APIRoute } from "astro";
import { clearSessionCookieHeader, deleteSession } from "~/lib/session";

export const prerender = false;

export const POST: APIRoute = async ({ locals, redirect }) => {
  const env = locals.runtime.env as Env;
  if (locals.sessionId) {
    await deleteSession(env.SESSIONS, locals.sessionId);
  }
  const res = redirect("/", 302);
  res.headers.append("Set-Cookie", clearSessionCookieHeader());
  return res;
};
