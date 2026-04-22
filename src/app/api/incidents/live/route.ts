// GET /api/incidents/live
// SSE: re-broadcast Kafka `incidents` topic, validated against IncidentSchema.
// Emits typed incident events in real-time to connected operators.
// Auth required.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createSseResponse } from "@/lib/streams/sse";
import { startKafkaSseConsumer } from "@/lib/streams/kafka-sse";
import { IncidentSchema } from "@/lib/schemas";
import type { Incident } from "@/lib/types";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return createSseResponse<Incident>(req.signal, async (write) => {
    const disconnect = await startKafkaSseConsumer({
      topic: "incidents",
      fromOffset: "latest",
      signal: req.signal,
      onMessage: (raw) => {
        const result = IncidentSchema.safeParse(raw);
        if (result.success) {
          write(result.data as Incident);
        }
        // Silently drop messages that don't match the schema.
      },
    });

    return disconnect;
  });
}
