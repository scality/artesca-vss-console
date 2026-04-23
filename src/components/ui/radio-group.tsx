"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface RadioGroupProps {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}

const RadioGroupContext = React.createContext<{
  value: string;
  onValueChange: (value: string) => void;
} | null>(null);

function RadioGroup({ value, onValueChange, className, children }: RadioGroupProps) {
  return (
    <RadioGroupContext.Provider value={{ value, onValueChange }}>
      <div role="radiogroup" className={cn("flex flex-col gap-2", className)}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

interface RadioGroupItemProps {
  value: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

function RadioGroupItem({ value, id, disabled, className }: RadioGroupItemProps) {
  const ctx = React.useContext(RadioGroupContext);
  if (!ctx) throw new Error("RadioGroupItem must be used inside RadioGroup");

  const checked = ctx.value === value;

  return (
    <button
      type="button"
      role="radio"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && ctx.onValueChange(value)}
      className={cn(
        "h-4 w-4 rounded-full border border-muted-foreground/50 flex items-center justify-center shrink-0",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked && "border-primary",
        className
      )}
    >
      {checked && (
        <span className="h-2 w-2 rounded-full bg-primary block" />
      )}
    </button>
  );
}

export { RadioGroup, RadioGroupItem };
