"use client";

import * as React from "react";
import { X, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

interface KeywordChipsProps {
  keywords: string[];
  onChange: (keywords: string[]) => void;
  disabled?: boolean;
}

export function KeywordChips({
  keywords,
  onChange,
  disabled,
}: KeywordChipsProps) {
  const [draft, setDraft] = React.useState("");

  const add = () => {
    const trimmed = draft.trim();
    if (trimmed && !keywords.includes(trimmed)) {
      onChange([...keywords, trimmed]);
    }
    setDraft("");
  };

  const remove = (kw: string) => {
    onChange(keywords.filter((k) => k !== kw));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    }
    if (e.key === "Backspace" && !draft && keywords.length > 0) {
      onChange(keywords.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-wrap gap-1 items-center min-h-8 rounded-md border border-input bg-background px-2 py-1">
      {keywords.map((kw) => (
        <Badge key={kw} variant="secondary" className="text-xs gap-1 pr-1">
          {kw}
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(kw)}
              className="hover:text-destructive ml-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </Badge>
      ))}
      {!disabled && (
        <input
          className="flex-1 min-w-[80px] bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          placeholder="Add keyword..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={add}
        />
      )}
    </div>
  );
}
