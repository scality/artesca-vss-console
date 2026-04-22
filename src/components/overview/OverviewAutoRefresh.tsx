"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { OverviewSnapshot } from "@/lib/types";
import { OverviewSnapshotSchema } from "@/lib/schemas";

/** Client island: polls /api/status/overview every 5 s and refreshes the page. */
export function OverviewAutoRefresh() {
  const router = useRouter();

  const { dataUpdatedAt } = useQuery<OverviewSnapshot>({
    queryKey: ["overview"],
    queryFn: async () => {
      const res = await fetch("/api/status/overview");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      return OverviewSnapshotSchema.parse(raw);
    },
    refetchInterval: 5_000,
    staleTime: 0,
  });

  // Each time fresh data arrives, trigger a server-component re-render via router.refresh()
  useEffect(() => {
    if (dataUpdatedAt > 0) {
      router.refresh();
    }
  }, [dataUpdatedAt, router]);

  return null; // renders nothing — side-effect only
}
