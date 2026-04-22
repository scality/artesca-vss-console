"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Upload, X, File } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface FeedDraft {
  feedId: string;
  fileName: string;
  fileBase64: string;
  rtspPreview: string;
}

interface FeedUploaderProps {
  cameraId: string;
  eip: string;
  feeds: FeedDraft[];
  onChange: (feeds: FeedDraft[]) => void;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip data URL prefix
      resolve(result.split(",")[1] ?? result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function FeedUploader({ cameraId, eip, feeds, onChange }: FeedUploaderProps) {
  const addFeed = () => {
    const idx = feeds.length;
    const feedId = idx === 0 ? "a" : idx === 1 ? "b" : `lens${idx + 1}`;
    const sensorId = `${cameraId}-${feedId}`;
    onChange([
      ...feeds,
      {
        feedId,
        fileName: "",
        fileBase64: "",
        rtspPreview: `rtsp://${eip}:8554/${sensorId}`,
      },
    ]);
  };

  const removeFeed = (idx: number) => {
    onChange(feeds.filter((_, i) => i !== idx));
  };

  const updateFeedId = (idx: number, feedId: string) => {
    const updated = feeds.map((f, i) => {
      if (i !== idx) return f;
      const sensorId = `${cameraId}-${feedId}`;
      return { ...f, feedId, rtspPreview: `rtsp://${eip}:8554/${sensorId}` };
    });
    onChange(updated);
  };

  const handleFile = async (idx: number, file: File | null) => {
    if (!file) return;
    const base64 = await toBase64(file);
    const updated = feeds.map((f, i) =>
      i === idx ? { ...f, fileName: file.name, fileBase64: base64 } : f
    );
    onChange(updated);
  };

  const handleDrop = async (idx: number, e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) await handleFile(idx, file);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Feeds</Label>
        <Button type="button" variant="outline" size="sm" onClick={addFeed}>
          + Add feed
        </Button>
      </div>

      {feeds.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No feeds. Add at least one.
        </p>
      )}

      {feeds.map((feed, idx) => (
        <div
          key={idx}
          className="rounded-md border border-border bg-muted/30 p-3 space-y-2"
        >
          <div className="flex items-center gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-xs text-muted-foreground">Feed ID</Label>
              <Input
                value={feed.feedId}
                onChange={(e) => updateFeedId(idx, e.target.value)}
                placeholder="a"
                className="h-8 text-sm"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mt-5 shrink-0"
              onClick={() => removeFeed(idx)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded border-2 border-dashed border-border p-3 text-center cursor-pointer transition-colors hover:border-primary/60",
              feed.fileName ? "bg-primary/5" : "bg-background"
            )}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(idx, e)}
            onClick={() => document.getElementById(`feed-file-${idx}`)?.click()}
          >
            {feed.fileName ? (
              <>
                <File className="h-5 w-5 text-primary" />
                <span className="text-xs font-medium text-primary">
                  {feed.fileName}
                </span>
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  Drop .ts file or click to browse
                </span>
              </>
            )}
            <input
              id={`feed-file-${idx}`}
              type="file"
              accept=".ts"
              className="hidden"
              onChange={(e) => handleFile(idx, e.target.files?.[0] ?? null)}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">RTSP URL (computed)</Label>
            <Input
              readOnly
              value={feed.rtspPreview}
              className="h-8 text-xs font-mono bg-muted cursor-default"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
