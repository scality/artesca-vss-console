/**
 * POST /api/tts
 *
 * Console-side proxy to the on-box NVIDIA Magpie TTS NIM
 * (POST /v1/audio/synthesize, multipart form language/text/voice -> WAV bytes).
 * The /chat page calls this when the operator picks the on-box ("NVIDIA") voice;
 * on any failure the client falls back to the browser's Web Speech engine, so a
 * TTS outage never leaves the chat mute.
 *
 * Request:  { text: string, voice?: string }
 * Response: audio/wav bytes on success; JSON { error } (502/503) on failure.
 *
 * Auth: gated by the same NextAuth session as the rest of the console.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

const TtsRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  voice: z.string().max(120).optional(),
});

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!CLUSTER.tts.enabled) {
    return NextResponse.json({ error: "on-box TTS disabled" }, { status: 503 });
  }

  const parsed = TtsRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  // Magpie's offline synth takes multipart form-data (language/text/voice) and
  // returns a WAV. fetch sets the multipart boundary from the FormData itself.
  const form = new FormData();
  form.append("language", CLUSTER.tts.language);
  form.append("text", parsed.data.text);
  form.append("voice", parsed.data.voice || CLUSTER.tts.voice);

  try {
    const resp = await fetch(`${CLUSTER.tts.url}/v1/audio/synthesize`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return NextResponse.json(
        { error: `magpie-tts HTTP ${resp.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const audio = await resp.arrayBuffer();
    return new NextResponse(audio, {
      status: 200,
      headers: {
        "content-type": resp.headers.get("content-type") || "audio/wav",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `magpie-tts unreachable: ${msg}` }, { status: 503 });
  }
});
