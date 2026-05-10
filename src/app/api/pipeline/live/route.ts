// GET /api/pipeline/live
// SSE stream: emits a PipelineSnapshot every 2 s as `event: snapshot`.
// Client disconnect terminates the loop. Auth-guarded.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { collectSnapshot } from "@/lib/pipeline/aggregator";
import { createSseResponse } from "@/lib/streams/sse";
import type { PipelineSnapshot } from "@/lib/types/pipeline";
import { createLogger } from "@/lib/logger";

const log = createLogger("api/pipeline/live");

export const dynamic = "force-dynamic";

const TICK_INTERVAL_MS = 2_000;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return createSseResponse<PipelineSnapshot>(req.signal, async (write) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (req.signal.aborted) return;
      try {
        const snapshot = await collectSnapshot();
        write(snapshot, "snapshot");
      } catch (err) {
        // collectSnapshot never throws, but guard defensively
        log.warn("snapshot error", { err: String(err) });
      }

      if (!req.signal.aborted) {
        timer = setTimeout(() => {
          void tick();
        }, TICK_INTERVAL_MS);
      }
    };

    // Start immediately
    void tick();

    // Cleanup: clear any pending timer on disconnect
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  });
}
