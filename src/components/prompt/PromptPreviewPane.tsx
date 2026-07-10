"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PromptPreviewPaneProps {
  currentModel: string;
}

export function PromptPreviewPane({ currentModel }: PromptPreviewPaneProps) {
  const { toast } = useToast();
  const [testMessage, setTestMessage] = React.useState("");
  const [response, setResponse] = React.useState<string | null>(null);
  const [latencyMs, setLatencyMs] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);

  const handlePreview = async () => {
    if (!testMessage.trim()) return;
    setLoading(true);
    setResponse(null);
    setLatencyMs(null);
    const t0 = Date.now();
    try {
      const res = await fetch("/api/prompt/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: testMessage }),
      });
      if (!res.ok) throw new Error("Preview request failed");
      const data = await res.json();
      setLatencyMs(Date.now() - t0);
      setResponse(data.response ?? data.output ?? JSON.stringify(data));
    } catch (err) {
      toast({
        title: "Preview failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Test message</Label>
        <textarea
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y min-h-[80px] outline-none focus:ring-2 focus:ring-ring"
          value={testMessage}
          onChange={(e) => setTestMessage(e.target.value)}
          placeholder="Describe a scene or paste a sample frame description..."
        />
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={handlePreview}
          disabled={loading || !testMessage.trim()}
          size="sm"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Play className="h-4 w-4 mr-1" />
              Preview
            </>
          )}
        </Button>
        {latencyMs !== null && (
          <span className="text-xs text-muted-foreground">
            {latencyMs} ms
          </span>
        )}
        <p className="text-xs text-muted-foreground">
          Live inference uses{" "}
          <span className="font-medium text-foreground">{currentModel}</span>.
        </p>
      </div>

      {response !== null && (
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground mb-1">Model response:</p>
          <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed">
            {response}
          </pre>
        </div>
      )}
    </div>
  );
}
