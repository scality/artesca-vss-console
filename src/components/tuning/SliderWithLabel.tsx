"use client";

import * as React from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface SliderWithLabelProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  description?: string;
  formatValue?: (v: number) => string;
}

export function SliderWithLabel({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  disabled,
  description,
  formatValue,
}: SliderWithLabelProps) {
  const displayValue = formatValue ? formatValue(value) : String(value);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-sm">{label}</Label>
        <span className="text-sm font-mono text-muted-foreground">
          {displayValue}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={cn(
          "w-full h-2 rounded-lg appearance-none cursor-pointer bg-muted",
          "accent-primary",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{min}</span>
        <span>{max}</span>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
