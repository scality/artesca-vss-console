/**
 * POST /api/chat
 *
 * Console-side proxy to the vss-agent's OpenAI-compatible /chat endpoint.
 * In the Helm layout, vss-agent is a Deployment in the vss-<profile> namespace.
 * Override VSS_AGENT_URL when the upstream placement differs.
 *
 * Body: { messages: [{ role: "user" | "assistant" | "system", content: string }] }
 * Returns the vss-agent's OpenAI ChatCompletion shape verbatim — the
 * console's /chat page reads `choices[0].message.content` and renders it.
 *
 * Auth: gated by the same NextAuth session as the rest of the console.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";

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
});

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = ChatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const body = parsed.data;

  try {
    const resp = await fetch(`${VSS_AGENT_URL}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: `vss-agent unreachable: ${(e as Error).message}` },
      { status: 503 },
    );
  }
});
