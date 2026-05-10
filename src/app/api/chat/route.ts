/**
 * POST /api/chat
 *
 * Console-side proxy to the nvidia-vss-agent's OpenAI-compatible /chat endpoint.
 * nvidia-vss-agent listens on host port 8000 in the upstream blueprint compose
 * network; from inside the console container we reach it as
 * `http://envoy-streamprocessing:8000` or, since envoy is on host network,
 * via the host's internal IP. Override VSS_AGENT_URL when the upstream
 * placement differs.
 *
 * Body: { messages: [{ role: "user" | "assistant" | "system", content: string }] }
 * Returns the nvidia-vss-agent's OpenAI ChatCompletion shape verbatim — the
 * console's /chat page reads `choices[0].message.content` and renders it.
 *
 * Auth: gated by the same NextAuth session as the rest of the console.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";

export const dynamic = "force-dynamic";

const VSS_AGENT_URL = process.env.VSS_AGENT_URL ?? "http://localhost:8000";

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
        { error: `nvidia-vss-agent HTTP ${resp.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: `nvidia-vss-agent unreachable: ${(e as Error).message}` },
      { status: 503 },
    );
  }
});
