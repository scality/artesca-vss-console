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

export const dynamic = "force-dynamic";

// Default to the in-cluster agent service derived from VSS_NAMESPACE (same
// convention as cluster-refs.ts) so the k8s path works without an explicit
// env. Only the docker path falls back to localhost:8000. The previous
// unconditional localhost default made the console call ITSELF on k8s →
// "vss-agent unreachable: fetch failed". Override with VSS_AGENT_URL.
const VSS_AGENT_URL =
  process.env.VSS_AGENT_URL ??
  (process.env.CONSOLE_RUNTIME === "docker"
    ? "http://localhost:8000"
    : `http://vss-agent.${process.env.VSS_NAMESPACE ?? "vss-base"}.svc.cluster.local:8000`);

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
