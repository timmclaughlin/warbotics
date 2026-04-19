import type { APIRoute } from "astro";
import { isAdmin } from "~/lib/acl";
import { loadConfig } from "~/lib/settings";

export const prerender = false;

// POST /api/settings/reindex { sourceId }
// Kicks off a ReindexSourceWorkflow instance. Returns { instanceId }.
export const POST: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime.env as Env;
  const user = locals.user;
  const config = await loadConfig(env);
  if (!isAdmin(user, config, env)) return new Response("Forbidden", { status: 403 });

  let body: { sourceId?: string };
  try {
    body = (await request.json()) as { sourceId?: string };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const sourceId = body.sourceId;
  if (!sourceId) return new Response("sourceId required", { status: 400 });

  const source = config.sources.find((s) => s.id === sourceId);
  if (!source) return new Response("Unknown source", { status: 404 });

  const instance = await env.REINDEX_WORKFLOW.create({
    params: {
      sourceId,
      initiatedBy: user?.email ?? "unknown",
    },
  });

  return Response.json({ instanceId: instance.id, sourceId });
};

// GET /api/settings/reindex?id=<instanceId>
// Returns the Workflow's current status so the UI can poll.
export const GET: APIRoute = async ({ locals, url }) => {
  const env = locals.runtime.env as Env;
  const user = locals.user;
  const config = await loadConfig(env);
  if (!isAdmin(user, config, env)) return new Response("Forbidden", { status: 403 });

  const id = url.searchParams.get("id");
  if (!id) return new Response("id required", { status: 400 });

  const instance = await env.REINDEX_WORKFLOW.get(id);
  const status = await instance.status();
  return Response.json({ id, ...status });
};
