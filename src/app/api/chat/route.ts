/**
 * POST /api/chat
 *
 * Console-side proxy to the vss-agent's OpenAI-compatible /chat endpoint.
 * In the Helm layout, vss-agent is a Deployment in the vss-<profile> namespace.
 * Override VSS_AGENT_URL when the upstream placement differs.
 *
 * Body: { messages: [...], conversationId?: string }
 * Returns the vss-agent's OpenAI ChatCompletion shape verbatim — the
 * console's /chat page reads `choices[0].message.content` and renders it.
 *
 * Multi-turn memory: the agent (nat top_agent) resolves follow-up references
 * ("it", "the clip", "yes") from server-side conversation history keyed by the
 * `conversation-id` request header — it does NOT thread the client `messages`
 * array beyond the last entry. Without the header every turn is a fresh thread,
 * so a pronoun follow-up gets "I don't have the prior context". The page sends a
 * stable per-conversation id; we forward it as that header.
 *
 * Auth: gated by the same NextAuth session as the rest of the console.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";
import { CLUSTER } from "@/lib/cluster-refs";
import {
  detectSearchIntent,
  buildSearchReplyMarkdown,
  type SearchHit,
  type SearchIntent,
} from "@/lib/chat-search-routing";

export const dynamic = "force-dynamic";

// Archive-search chat routing. The closed vss-agent has no video_search tool,
// so "find every forklift incident"-style asks are answered from the
// caption-indexer (/search) directly instead of the agent. Set
// VSS_CHAT_SEARCH_ROUTING="0" to disable and send everything to the agent.
const CHAT_SEARCH_ROUTING = process.env.VSS_CHAT_SEARCH_ROUTING !== "0";

// Default to the in-cluster agent service derived from VSS_NAMESPACE (same
// convention as cluster-refs.ts) so the k8s path works without an explicit
// env. The previous
// unconditional localhost default made the console call ITSELF on k8s →
// "vss-agent unreachable: fetch failed". Override with VSS_AGENT_URL.
const VSS_AGENT_URL =
  process.env.VSS_AGENT_URL ??
  `http://vss-agent.${process.env.VSS_NAMESPACE ?? "vss-base"}.svc.cluster.local:8000`;

const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
  })).min(1),
  model: z.string().optional(),
  conversationId: z.string().min(1).max(200).optional(),
});

interface ChatCompletionShape {
  choices?: Array<{ message?: { content?: string } }>;
}

// Calls the caption-indexer /search and renders the hits as a chat reply.
// Fail-soft: a worker outage returns an honest inline message (with a Search
// page link), never a throw, so a search ask never 500s the chat.
async function answerFromSearch(intent: SearchIntent): Promise<string> {
  const reqBody: Record<string, unknown> = { query: intent.query, limit: 8 };
  if (intent.sensor) reqBody.sensor = intent.sensor;
  try {
    const resp = await fetch(`${CLUSTER.search.url}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return `⚠ Semantic search is temporarily unavailable (caption-indexer HTTP ${resp.status}). You can try the [Search page](/search).`;
    }
    const data = (await resp.json()) as { hits?: SearchHit[] };
    return buildSearchReplyMarkdown(intent.query, data.hits ?? []);
  } catch (e) {
    return `⚠ Semantic search is temporarily unavailable (${(e as Error).message}). You can try the [Search page](/search).`;
  }
}

// Wraps assistant markdown in the OpenAI ChatCompletion shape the /chat page
// reads (choices[0].message.content), so a search-routed reply is
// indistinguishable to the client from an agent reply.
function asChatCompletion(content: string): ChatCompletionShape {
  return { choices: [{ message: { content } }] };
}

// Rewrites the agent's browser-unreachable media host (vss-agent:8000) to the
// console's own same-origin /api/media proxy, so a snapshot/clip URL in the
// reply opens directly in the browser. Config: CLUSTER.mediaProxyEnabled
// (env VSS_MEDIA_PROXY_ENABLED). Mutates in place — cheap, response is fresh.
function rewriteMediaUrls(data: ChatCompletionShape): void {
  const prefix = `http://${CLUSTER.agent.mediaHost}`;
  for (const choice of data.choices ?? []) {
    const content = choice.message?.content;
    if (choice.message && typeof content === "string" && content.includes(prefix)) {
      choice.message.content = content.split(prefix).join("/api/media");
    }
  }
}

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = ChatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const body = parsed.data;

  // Archive-search shortcut: answer "find every …"-style asks from the
  // caption-indexer instead of the agent (which has no video_search tool).
  if (CHAT_SEARCH_ROUTING) {
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    const intent = lastUser ? detectSearchIntent(lastUser.content) : null;
    if (intent) {
      const reply = await answerFromSearch(intent);
      return NextResponse.json(asChatCompletion(reply));
    }
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  // Keys the agent's server-side conversation history so follow-ups resolve
  // references across turns (nat runtime/session reads `conversation-id`).
  if (body.conversationId) headers["conversation-id"] = body.conversationId;

  try {
    const resp = await fetch(`${VSS_AGENT_URL}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: body.messages, model: body.model }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return NextResponse.json(
        { error: `vss-agent HTTP ${resp.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = await resp.json();
    if (CLUSTER.mediaProxyEnabled) rewriteMediaUrls(data);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: `vss-agent unreachable: ${(e as Error).message}` },
      { status: 503 },
    );
  }
});
