// Tool definitions for the chat agent. Each tool is a thin wrapper over
// the AiSearch client scoped to one instance. Structured this way so the
// same tools can be dropped into an AIChatAgent Durable Object later
// (Path A) without changing the shape of the tool-calling layer.

import { tool } from "ai";
import { z } from "zod";
import { AiSearch, userInstanceId } from "~/lib/search";
import { sourceUrl } from "~/lib/urls";

interface ToolContext {
  search: AiSearch;
  user: {
    slackUserId: string;
    slackTeamId: string;
    aiSearchInstanceId: string;
  };
  contentInstanceId: string;
  wpilibInstanceId: string;
}

interface ChunkSummary {
  source: string;
  key?: string;
  title?: string;
  url?: string;
  excerpt: string;
  score: number;
}

function summarizeChunks(chunks: Awaited<ReturnType<AiSearch["search"]>>["chunks"]): ChunkSummary[] {
  return chunks.map((c) => {
    const meta = (c.item?.metadata ?? {}) as Record<string, unknown>;
    const title = typeof meta.title === "string" ? meta.title : undefined;
    const excerpt = c.text.replace(/^---[\s\S]*?---\s*/, "").replace(/\s+/g, " ").slice(0, 600);
    return {
      source: c.instance_id,
      key: c.item?.key,
      title,
      url: sourceUrl(c.instance_id, c.item?.key, meta),
      excerpt,
      score: c.score,
    };
  });
}

export function buildAgentTools(ctx: ToolContext) {
  return {
    search_team_docs: tool({
      description:
        "Search the Warbotics team's internal documentation (custom FRC/robotics notes the team has written).",
      inputSchema: z.object({
        query: z.string().describe("A natural-language query."),
        limit: z.number().int().min(1).max(10).default(5).optional(),
      }),
      execute: async ({ query, limit }) => {
        const res = await ctx.search.search(query, [ctx.contentInstanceId], {
          limit: limit ?? 5,
          rerank: true,
        });
        return summarizeChunks(res.chunks);
      },
    }),

    search_wpilib: tool({
      description:
        "Search the official WPILib documentation (frc-docs). Use this for questions about WPILib APIs, robot programming, FRC rules, tutorials, and anything FIRST Robotics Competition-specific.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(10).default(5).optional(),
      }),
      execute: async ({ query, limit }) => {
        const res = await ctx.search.search(query, [ctx.wpilibInstanceId], {
          limit: limit ?? 5,
          rerank: true,
        });
        return summarizeChunks(res.chunks);
      },
    }),

    search_my_notes: tool({
      description:
        "Search the current user's personal notes and prior queries. Use this when the user references something they asked or saved before, like 'what did I ask about swerve last week' or 'look up my note on…'.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(10).default(5).optional(),
      }),
      execute: async ({ query, limit }) => {
        const res = await ctx.search.search(query, [ctx.user.aiSearchInstanceId], {
          limit: limit ?? 5,
        });
        return summarizeChunks(res.chunks);
      },
    }),

    save_note: tool({
      description:
        "Save a note into the user's personal knowledge base so they (and the agent) can find it via search_my_notes later. Use this when the user says 'remember that…', 'save this…', or similar.",
      inputSchema: z.object({
        title: z.string().describe("A short label for the note."),
        body: z.string().describe("The full note content."),
      }),
      execute: async ({ title, body }) => {
        const safeTitle = title.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 60) || "note";
        const key = `note-${safeTitle}-${Date.now()}.md`;
        const content = `---\ntype: note\nuser: ${ctx.user.slackUserId}\n---\n\n# ${title}\n\n${body}\n`;
        await ctx.search.uploadItem(ctx.user.aiSearchInstanceId, key, content, {
          type: "note",
          title,
          user_id: ctx.user.slackUserId,
          ts: Date.now(),
        });
        return { saved: true, key };
      },
    }),
  };
}

export function userToolInstanceIdsFor(slackUserId: string): string {
  return userInstanceId(slackUserId);
}
