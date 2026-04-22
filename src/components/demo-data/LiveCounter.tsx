"use client";

import { useEffect, useRef, useState } from "react";

/** Counts messages produced by the demo-data SSE stream in the last 60 s. */
export function LiveCounter() {
  const [count, setCount] = useState(0);
  const timestampsRef = useRef<number[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/kafka/vision-llm-responses");
    esRef.current = es;

    es.addEventListener("message", () => {
      const now = Date.now();
      timestampsRef.current.push(now);
      // Prune entries older than 60 s
      const cutoff = now - 60_000;
      timestampsRef.current = timestampsRef.current.filter((t) => t >= cutoff);
      setCount(timestampsRef.current.length);
    });

    es.addEventListener("error", () => {
      // Reconnect is handled automatically by EventSource
    });

    // Tick to prune stale counts even when no new messages arrive
    const pruneInterval = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      timestampsRef.current = timestampsRef.current.filter((t) => t >= cutoff);
      setCount(timestampsRef.current.length);
    }, 5_000);

    return () => {
      es.close();
      clearInterval(pruneInterval);
    };
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-4xl font-bold tabular-nums">{count}</span>
      <span className="text-sm text-muted-foreground">messages produced in last 60 s</span>
    </div>
  );
}
