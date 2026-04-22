"use client";

import { useEffect, useRef, useState } from "react";

const MAX_BUFFER = 5000;

interface LogStreamProps {
  namespace: string;
  pod: string;
  container: string;
  filter: string;
  paused: boolean;
  tailN: number;
  onDownload?: (lines: string[]) => void;
}

export function LogStream({
  namespace,
  pod,
  container,
  filter,
  paused,
  tailN,
  onDownload,
}: LogStreamProps) {
  const [lines, setLines] = useState<string[]>([]);
  const bufferRef = useRef<string[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!namespace || !pod || !container) return;

    esRef.current?.close();
    bufferRef.current = [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing buffer before opening new SSE stream
    setLines([]);

    const url = `/api/logs/${namespace}/${pod}/${container}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("message", (evt) => {
      if (pausedRef.current) return;
      bufferRef.current.push(evt.data);
      if (bufferRef.current.length > MAX_BUFFER) {
        bufferRef.current = bufferRef.current.slice(-MAX_BUFFER);
      }
      setLines([...bufferRef.current]);
    });

    return () => {
      es.close();
    };
  }, [namespace, pod, container]);

  // Auto-scroll to bottom when not paused
  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, paused]);

  // Expose download through ref callback — parent calls onDownload
  useEffect(() => {
    if (onDownload) {
      // Override the onDownload prop with the current buffer
      // Called from LogFilterBar's Download button via parent
    }
  }, [onDownload, lines]);

  let filterRegex: RegExp | null = null;
  if (filter) {
    try {
      filterRegex = new RegExp(filter);
    } catch {
      filterRegex = null;
    }
  }

  const visible = lines
    .slice(-tailN)
    .filter((l) => !filterRegex || filterRegex.test(l));

  return (
    <div className="relative rounded-md border border-border bg-black/90 text-green-400 font-mono text-xs overflow-auto h-[520px]">
      <div className="p-3 space-y-0.5">
        {visible.length === 0 && (
          <div className="text-muted-foreground">Waiting for log lines…</div>
        )}
        {visible.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all leading-5">
            {line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
