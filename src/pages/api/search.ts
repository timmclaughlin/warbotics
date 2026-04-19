import type { APIRoute } from "astro";
import { searchClientFromEnv } from "~/lib/search";
import { sourceUrl } from "~/lib/urls";

export const prerender = false;

interface UiResult {
  id: string;
  source: string;
  title: string;
  snippet: string;
  key?: string;
  score: number;
  url?: string;
}

function titleFromChunk(text: string, meta: Record<string, unknown> | undefined, key: string | undefined): string {
  const metaTitle = meta?.title;
  if (typeof metaTitle === "string" && metaTitle.trim()) return metaTitle;

  // Pull the first heading-ish line from the chunk as a fallback.
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "---" || line.startsWith("---")) continue;
    if (line.startsWith("#")) return line.replace(/^#+\s*/, "").slice(0, 100);
    if (/^[A-Za-z0-9]/.test(line)) return line.slice(0, 100);
  }
  return key ?? "Untitled";
}

function snippetFromChunk(text: string, query: string): string {
  // Strip frontmatter, normalize RST/Sphinx markup so marked can render
  // code inline, then collapse whitespace for a readable preview.
  let body = text.replace(/^---[\s\S]*?---\s*/, "");
  body = body
    // RST inline code: ``addPeriodic()`` → `addPeriodic()`
    .replace(/``([^`\n]+)``/g, "`$1`")
    // Sphinx roles: :doc:`foo`, :ref:`bar` → `foo`
    .replace(/:[a-zA-Z-]+:`([^`]+)`/g, "`$1`");
  body = body.replace(/\s+/g, " ").trim();
  const q = query.toLowerCase();
  const idx = body.toLowerCase().indexOf(q);
  const len = 240;
  if (idx < 0) return body.slice(0, len);
  const start = Math.max(0, idx - 80);
  const end = Math.min(body.length, start + len);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  return `${prefix}${body.slice(start, end)}${suffix}`;
}


export const GET: APIRoute = async ({ locals, url }) => {
  const env = locals.runtime.env as Env;
  const q = url.searchParams.get("q")?.trim();
  if (!q) {
    return Response.json({ query: "", results: [] });
  }

  const instanceIds: string[] = [];
  if (env.AI_SEARCH_INSTANCE_CONTENT) instanceIds.push(env.AI_SEARCH_INSTANCE_CONTENT);
  if (env.AI_SEARCH_INSTANCE_WPILIB) instanceIds.push(env.AI_SEARCH_INSTANCE_WPILIB);
  if (locals.user) instanceIds.push(locals.user.aiSearchInstanceId);

  try {
    const client = searchClientFromEnv(env);
    const res = await client.search(q, instanceIds, { limit: 15, rerank: true });

    const results: UiResult[] = res.chunks.map((c) => ({
      id: c.id,
      source: c.instance_id,
      title: titleFromChunk(c.text, c.item?.metadata, c.item?.key),
      snippet: snippetFromChunk(c.text, q),
      key: c.item?.key,
      score: c.score,
      url: sourceUrl(c.instance_id, c.item?.key, c.item?.metadata),
    }));

    // Best-effort: log the query into the caller's personal instance so
    // future searches can surface prior context. Non-blocking.
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

    return Response.json({ query: q, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(msg, { status: 500 });
  }
};
