import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";

export const dynamic = "force-dynamic";

const PreviewSchema = z.object({
  prompt: z.string().min(1),
  userMessage: z.string().min(1),
});

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PreviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { prompt, userMessage } = parsed.data;

  const previewEndpoint =
    process.env.NIM_PREVIEW_ENDPOINT ??
    "http://nim-preview.rtvi.svc.cluster.local:8000/v1/chat/completions";

  const previewModel =
    process.env.NIM_PREVIEW_MODEL ?? "nvila-lite-2b";

  const payload = {
    model: previewModel,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userMessage },
    ],
    max_tokens: 512,
    temperature: 0.1,
  };

  const startMs = Date.now();

  try {
    const resp = await fetch(previewEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });

    const latencyMs = Date.now() - startMs;

    if (!resp.ok) {
      const errBody = await resp.text();
      return NextResponse.json(
        { error: `Preview NIM returned HTTP ${resp.status}: ${errBody}` },
        { status: 502 }
      );
    }

    const json = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };

    const response = json.choices?.[0]?.message?.content ?? "";
    const model = json.model ?? previewModel;

    return NextResponse.json({ response, latencyMs, model });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Preview NIM unreachable: ${msg}` },
      { status: 503 }
    );
  }
});
