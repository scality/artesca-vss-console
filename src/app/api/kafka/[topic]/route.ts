// GET /api/kafka/[topic]
// SSE: consume a Kafka topic and emit each message as an SSE event.
// Allowed topics: vision-llm-responses, incidents, alerts-demo-data.
// Query params:
//   from    "earliest" (default) | "latest"
//   replay  N — emit N most-recent messages (from beginning) before going live

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createSseResponse } from "@/lib/streams/sse";
import {
  ALLOWED_TOPICS,
  startKafkaSseConsumer,
} from "@/lib/streams/kafka-sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ topic: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { topic } = await params;

  if (!ALLOWED_TOPICS.has(topic as never)) {
    return NextResponse.json(
      {
        error: `Topic "${topic}" not allowed. Allowed: ${[...ALLOWED_TOPICS].join(", ")}`,
      },
      { status: 400 }
    );
  }

  const sp = req.nextUrl.searchParams;
  const fromOffset =
    sp.get("from") === "latest" ? "latest" : "earliest";
  const replayCount = sp.has("replay")
    ? Math.max(0, parseInt(sp.get("replay")!, 10))
    : 0;

  return createSseResponse<unknown>(req.signal, async (write) => {
    const disconnect = await startKafkaSseConsumer({
      topic,
      fromOffset,
      replayCount,
      signal: req.signal,
      onMessage: write,
    });

    return disconnect;
  });
}
