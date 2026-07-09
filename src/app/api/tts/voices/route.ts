/**
 * GET /api/tts/voices
 *
 * Availability probe + voice list for the on-box Magpie TTS NIM. The /chat
 * voice selector calls this to decide whether to offer the "NVIDIA (on-box)"
 * engine and which voices to list. Always fail-soft: returns
 * { available:false, voices:[], default } when the NIM is disabled/unreachable,
 * so the selector simply omits the on-box option instead of erroring.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { CLUSTER } from "@/lib/cluster-refs";
import { parseVoiceList } from "@/lib/tts-voices";

export const dynamic = "force-dynamic";

export const GET = withRequestContext(async function (_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const fallback = { available: false, voices: [] as string[], default: CLUSTER.tts.voice };
  if (!CLUSTER.tts.enabled) return NextResponse.json(fallback);

  try {
    const resp = await fetch(`${CLUSTER.tts.url}/v1/audio/list_voices`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (!resp.ok) return NextResponse.json(fallback);
    const data = await resp.json().catch(() => null);
    const voices = parseVoiceList(data);
    return NextResponse.json({
      available: true,
      voices: voices.length ? voices : [CLUSTER.tts.voice],
      default: CLUSTER.tts.voice,
    });
  } catch {
    return NextResponse.json(fallback);
  }
});
