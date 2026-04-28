/**
 * POST /api/chat
 *
 * Console-side proxy to the vss-agent's OpenAI-compatible /chat endpoint.
 * vss-agent listens on host port 8000 in the upstream blueprint compose
 * network; from inside the console container we reach it as
 * `http://envoy-streamprocessing:8000` or, since envoy is on host network,
 * via the host's internal IP. Override VSS_AGENT_URL when the upstream
 * placement differs.
 *
 * Body: { messages: [{ role: "user" | "assistant" | "system", content: string }] }
 * Returns the vss-agent's OpenAI ChatCompletion shape verbatim — the
 * console's /chat page reads `choices[0].message.content` and renders it.
 *
 * Auth: gated by the same NextAuth session as the rest of the console.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const VSS_AGENT_URL = process.env.VSS_AGENT_URL ?? "http://172.27.16.237:8000";

type ChatRequest = {
  messages: { role: string; content: string }[];
  model?: string;
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }

  try {
    const resp = await fetch(`${VSS_AGENT_URL}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: body.messages, model: body.model }),
      signal: AbortSignal.timeout(60_000),
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
}
