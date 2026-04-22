"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatAge } from "@/lib/utils";

export interface DiagnosticTest {
  id: string;
  label: string;
  description: string;
  lastRun: string | null; // ISO 8601
  lastResult: "pass" | "fail" | null;
}

interface DiagnosticCardProps {
  test: DiagnosticTest;
  running: boolean;
  onRun: () => void;
  onShowOutput: () => void;
}

export function DiagnosticCard({ test, running, onRun, onShowOutput }: DiagnosticCardProps) {
  // eslint-disable-next-line react-hooks/purity -- Date.now() for display age only; staleness on re-render is acceptable
  const ageMs = test.lastRun ? Date.now() - new Date(test.lastRun).getTime() : null;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium leading-snug">{test.label}</CardTitle>
          {test.lastResult && (
            <Badge
              variant={test.lastResult === "pass" ? "default" : "destructive"}
              className={`shrink-0 text-[10px] ${test.lastResult === "pass" ? "bg-green-600" : ""}`}
            >
              {test.lastResult}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{test.description}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 mt-auto">
        {ageMs !== null && (
          <p className="text-xs text-muted-foreground">
            Last run: {formatAge(ageMs)} ago
          </p>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onRun}
            disabled={running}
            className="flex-1"
          >
            {running ? "Running…" : "Run now"}
          </Button>
          {test.lastRun && (
            <Button size="sm" variant="outline" onClick={onShowOutput}>
              View output
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
