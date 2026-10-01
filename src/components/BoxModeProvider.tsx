"use client";

import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BoxMode } from "@/lib/box-mode-shared";

// The AI Factory UI's URL comes from the server (env AI_FACTORY_URL, read at
// request time by the root layout), so a ConfigMap change reaches the link
// without a rebuild. The box's mode is polled from GET /api/box-mode.

const AiFactoryUrlContext = createContext<string>("http://localhost:4090");

export function BoxModeProvider({
  aiFactoryUrl,
  children,
}: {
  aiFactoryUrl: string;
  children: React.ReactNode;
}) {
  return <AiFactoryUrlContext.Provider value={aiFactoryUrl}>{children}</AiFactoryUrlContext.Provider>;
}

export function useAiFactoryUrl(): string {
  return useContext(AiFactoryUrlContext);
}

/** Same cadence as the server cache: a fresh read at most every ~10 s. */
export const BOX_MODE_POLL_MS = 10_000;

/** The box's GPU mode, or null until the first answer (and on any error —
 *  a console that cannot tell renders as it always has). */
export function useBoxMode(): BoxMode | null {
  const { data } = useQuery({
    queryKey: ["box-mode"],
    queryFn: async (): Promise<BoxMode | null> => {
      const res = await fetch("/api/box-mode", { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<BoxMode>;
      return typeof body.mode === "string" ? (body as BoxMode) : null;
    },
    refetchInterval: BOX_MODE_POLL_MS,
    staleTime: BOX_MODE_POLL_MS / 2,
    retry: false,
  });
  return data ?? null;
}
