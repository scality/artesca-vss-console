"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface LogFilterBarProps {
  filter: string;
  onFilterChange: (v: string) => void;
  paused: boolean;
  onPauseToggle: () => void;
  tailN: number;
  onTailNChange: (n: number) => void;
  onDownload: () => void;
  disabled?: boolean;
}

export function LogFilterBar({
  filter,
  onFilterChange,
  paused,
  onPauseToggle,
  tailN,
  onTailNChange,
  onDownload,
  disabled,
}: LogFilterBarProps) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-48 space-y-1">
        <Label htmlFor="log-filter">Filter (regex)</Label>
        <Input
          id="log-filter"
          placeholder="e.g. ERROR|WARN"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1">
        <Label>Tail lines</Label>
        <select
          value={tailN}
          onChange={(e) => onTailNChange(Number(e.target.value))}
          disabled={disabled}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        >
          {[50, 100, 250, 500, 1000].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
      <Button variant="outline" onClick={onPauseToggle} disabled={disabled}>
        {paused ? "Resume" : "Pause"}
      </Button>
      <Button variant="outline" onClick={onDownload} disabled={disabled}>
        Download
      </Button>
    </div>
  );
}
