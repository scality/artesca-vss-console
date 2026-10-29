"use client";

import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BoxMode } from "@/lib/box-mode-shared";

// The AI Factory UI's URL comes from the server (env AI_FACTORY_URL, read at
// request time by the root layout), so a ConfigMap change reaches the link
// without a rebuild. null (env unset) = render no AI Factory link. The box's
// mode is polled from GET /api/box-mode. The upstream VSS agent UI's URL (env
// VSS_AGENT_UI_URL, /chat's "open upstream UI") rides along the same way.

const AiFactoryUrlContext = createContext<string | null>(null);
const AgentUiUrlContext = createContext<string | null>(null);

export function BoxModeProvider({
  aiFactoryUrl,
  agentUiUrl = null,
  children,
}: {
  aiFactoryUrl: string | null;
  agentUiUrl?: string | null;
  children: React.ReactNode;
}) {
  return (
    <AiFactoryUrlContext.Provider value={aiFactoryUrl}>
      <AgentUiUrlContext.Provider value={agentUiUrl}>{children}</AgentUiUrlContext.Provider>
    </AiFactoryUrlContext.Provider>
  );
}

export function useAiFactoryUrl(): string | null {
  return useContext(AiFactoryUrlContext);
}

/** null = VSS_AGENT_UI_URL unset: render no link to the upstream agent UI. */
export function useAgentUiUrl(): string | null {
  return useContext(AgentUiUrlContext);
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
