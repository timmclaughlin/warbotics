import type { APIRoute } from "astro";
import { searchClientFromEnv } from "~/lib/search";

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  const env = locals.runtime.env as Env;
  const q = url.searchParams.get("q")?.trim();
  if (!q) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const instanceIds: string[] = [];
  if (env.AI_SEARCH_INSTANCE_CONTENT) instanceIds.push(env.AI_SEARCH_INSTANCE_CONTENT);
  if (env.AI_SEARCH_INSTANCE_WPILIB) instanceIds.push(env.AI_SEARCH_INSTANCE_WPILIB);
  if (locals.user) instanceIds.push(locals.user.aiSearchInstanceId);

  try {
    const client = searchClientFromEnv(env);
    const res = await client.search(q, instanceIds, { limit: 15, rerank: true });

    // Best-effort log of the query into the user's personal instance so future
    // searches can surface prior context. Non-blocking — don't slow the response.
    if (locals.user) {
      const userInstance = locals.user.aiSearchInstanceId;
      const key = `query-${Date.now()}.md`;
      const body = `---\ntype: query\nuser: ${locals.user.slackUserId}\n---\n\n# ${q}\n`;
      locals.runtime.ctx.waitUntil(
        client
          .uploadItem(userInstance, key, body, {
            type: "query",
            user_id: locals.user.slackUserId,
            team_id: locals.user.slackTeamId,
            ts: Date.now(),
          })
          .catch((err) => console.warn("query-log upload failed", err)),
      );
    }

    return new Response(JSON.stringify(res), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(msg, { status: 500 });
  }
};
