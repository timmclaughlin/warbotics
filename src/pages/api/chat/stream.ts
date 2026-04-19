import type { APIRoute } from "astro";
import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { searchClientFromEnv } from "~/lib/search";
import { buildAgentTools } from "~/lib/agent-tools";

export const prerender = false;

const MODEL_ID = "@cf/moonshotai/kimi-k2.5";

const SYSTEM_PROMPT = `You are the Warbotics assistant: a robotics coach for an FRC team.
You help with FIRST Robotics Competition (FRC) programming, WPILib, mechanical/electrical
concepts, and the team's own documentation and prior discussions.

You have four tools:
- search_team_docs — the Warbotics team's own internal documentation
- search_wpilib    — the official WPILib documentation (frc-docs). Use this for anything
                     WPILib, RoboRIO, kinematics, command-based, PID, vision, FRC-specific.
- search_my_notes  — the current user's personal note/query history
- save_note        — save something into the current user's personal knowledge base

Rules:
1. Before answering any factual question about WPILib or FRC, call search_wpilib.
2. Before answering about team-specific process, call search_team_docs.
3. When you reference source material, cite the \`key\` from the tool result inline.
4. If the user says "remember that …" or "save …", call save_note.
5. If you can't find the answer in the tools, say so plainly — do not make things up.

Formatting:
- Output valid GitHub-flavored Markdown. Use real line breaks — put a blank
  line between paragraphs, before every \`##\` heading, and before every list.
- Never jam a heading onto the end of a previous sentence. A heading is
  always on its own line, preceded by a blank line.
- Use short paragraphs and bullet lists. Inline code uses backticks.
- Keep answers focused; expand only when the user asks for more detail.`;

interface ChatRequestBody {
  messages: UIMessage[];
}

export const POST: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime.env as Env;
  const user = locals.user;
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response("messages[] is required", { status: 400 });
  }

  const workersai = createWorkersAI({ binding: env.AI });
  const search = searchClientFromEnv(env);
  const tools = buildAgentTools({
    search,
    user: {
      slackUserId: user.slackUserId,
      slackTeamId: user.slackTeamId,
      aiSearchInstanceId: user.aiSearchInstanceId,
    },
    contentInstanceId: env.AI_SEARCH_INSTANCE_CONTENT,
    wpilibInstanceId: env.AI_SEARCH_INSTANCE_WPILIB,
  });

  // Log the latest user turn into the caller's personal AI Search instance so
  // search_my_notes can surface it in future sessions. Non-blocking.
  const last = body.messages[body.messages.length - 1];
  if (last?.role === "user") {
    const text = extractText(last);
    if (text) {
      const key = `chat-${Date.now()}.md`;
      const content = `---\ntype: chat_turn\nuser: ${user.slackUserId}\n---\n\n# ${text.slice(0, 80)}\n\n${text}\n`;
      locals.runtime.ctx.waitUntil(
        search
          .uploadItem(user.aiSearchInstanceId, key, content, {
            type: "chat_turn",
            user_id: user.slackUserId,
            ts: Date.now(),
          })
          .catch((err) => console.warn("chat turn upload failed", err)),
      );
    }
  }

  const result = streamText({
    model: workersai(MODEL_ID),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(body.messages),
    tools,
    stopWhen: stepCountIs(6),
  });

  return result.toUIMessageStreamResponse({
    sendSources: true,
    sendReasoning: false,
  });
};

function extractText(m: UIMessage): string {
  if (!Array.isArray(m.parts)) return "";
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}
