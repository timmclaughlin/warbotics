import type { APIRoute } from "astro";
import { isAdmin } from "~/lib/acl";
import { loadConfig, saveConfig, validateConfig, type AppConfig } from "~/lib/settings";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env as Env;
  const user = locals.user;
  const config = await loadConfig(env);
  if (!isAdmin(user, config, env)) {
    return new Response("Forbidden", { status: 403 });
  }
  return Response.json(config);
};

export const PUT: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime.env as Env;
  const user = locals.user;
  const existing = await loadConfig(env);
  if (!isAdmin(user, existing, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const error = validateConfig(body);
  if (error) return new Response(error, { status: 400 });

  // Prevent the caller from locking themselves out: if they remove
  // themselves from admins AND they're not the OWNER_EMAIL, reject.
  const next = body as AppConfig;
  const callerEmail = user?.email?.toLowerCase() ?? "";
  const ownerEmail = env.OWNER_EMAIL?.toLowerCase() ?? "";
  const nextAdminEmails = next.admins.map((a) => a.toLowerCase());
  if (
    callerEmail &&
    callerEmail !== ownerEmail &&
    !nextAdminEmails.includes(callerEmail)
  ) {
    return new Response(
      "Refusing to save: you'd lock yourself out. Keep your own email in the admins list.",
      { status: 400 },
    );
  }

  const saved = await saveConfig(env, next, callerEmail || "unknown");
  return Response.json(saved);
};
