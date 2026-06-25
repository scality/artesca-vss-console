"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Feed } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Ban, Upload } from "lucide-react";
import { LiveFeedPlayer } from "./LiveFeedPlayer";

interface FeedListProps {
  cameraId: string;
  feeds: Feed[];
  eip: string;
}

export function FeedList({ cameraId, feeds, eip }: FeedListProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const disableFeed = useMutation({
    mutationFn: async (feedId: string) => {
      const res = await fetch(`/api/cameras/${cameraId}/feeds/${feedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      if (!res.ok) throw new Error("Failed to disable feed");
    },
    onSuccess: (_, feedId) => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({ title: `Feed ${feedId} disabled` });
    },
    onError: () => {
      toast({ title: "Failed to disable feed", variant: "destructive" });
    },
  });

  const reRegister = useMutation({
    mutationFn: async (feedId: string) => {
      const res = await fetch(`/api/cameras/${cameraId}/feeds/${feedId}/register`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Re-registration failed");
    },
    onSuccess: (_, feedId) => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({ title: `Feed ${feedId} re-registered` });
    },
    onError: () => {
      toast({ title: "Re-registration failed", variant: "destructive" });
    },
  });

  if (feeds.length === 0) {
    return <p className="text-xs text-muted-foreground pl-4">No feeds</p>;
  }

  return (
    <div className="pl-4 space-y-2">
      {feeds.map((feed) => (
        <div
          key={feed.id}
          className="flex flex-wrap items-start gap-3 rounded bg-muted/30 px-3 py-2"
        >
          <LiveFeedPlayer eip={eip} sensorId={feed.sensorId} />
          <span className="text-xs font-mono text-muted-foreground w-20 shrink-0 mt-1">
            {feed.id}
          </span>
          <span className="text-xs font-mono text-foreground truncate max-w-[200px] mt-1">
            {feed.rtspUrl}
          </span>
          <div className="flex gap-1 flex-wrap">
            {feed.vstRegistered ? (
              <Badge variant="outline" className="text-xs bg-emerald-50 border-emerald-200 text-emerald-700">
                VST
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs bg-amber-50 border-amber-200 text-amber-700">
                unregistered
              </Badge>
            )}
            {feed.replayReady ? (
              <Badge variant="outline" className="text-xs bg-emerald-50 border-emerald-200 text-emerald-700">
                replay ready
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs border-muted-foreground text-muted-foreground">
                not ready
              </Badge>
            )}
            {feed.bitrateMbps && (
              <Badge variant="secondary" className="text-xs">
                {feed.bitrateMbps.toFixed(1)} Mbps
              </Badge>
            )}
            {feed.fps && (
              <Badge variant="secondary" className="text-xs">
                {feed.fps} fps
              </Badge>
            )}
          </div>
          <div className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => reRegister.mutate(feed.id)}
              disabled={reRegister.isPending}
              title="Re-register with VST"
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Re-register
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => disableFeed.mutate(feed.id)}
              disabled={disableFeed.isPending}
              title="Disable feed"
            >
              <Ban className="h-3 w-3 mr-1" />
              Disable
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
