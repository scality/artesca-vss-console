"use client";

import { useEffect, useRef, useState } from "react";

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectDropdownProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Shown inside the panel (and as a button tooltip) when there are no options. */
  emptyHint?: string;
}

/**
 * A compact button + checkbox-popover multi-select. Native `<select multiple>`
 * is awkward on a touch/kiosk display, so this renders a labelled trigger with a
 * count badge that opens a scrollable checklist. Closes on outside click.
 */
export function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  emptyHint,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  function toggle(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  }

  const count = selected.length;
  const disabled = options.length === 0;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={disabled ? emptyHint : undefined}
        className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
          count > 0
            ? "border-primary/60 bg-primary/10 text-primary"
            : "border-border bg-background text-muted-foreground hover:text-foreground"
        }`}
      >
        <span>{label}</span>
        {count > 0 && (
          <span className="rounded-full bg-primary/20 px-1.5 text-[10px] tabular-nums text-primary">
            {count}
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          aria-hidden
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M2 4l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-64 w-56 overflow-auto rounded-md border border-border bg-background p-1 shadow-lg">
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {emptyHint ?? "No options"}
            </div>
          ) : (
            <>
              {count > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="mb-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                >
                  Clear selection
                </button>
              )}
              {options.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(opt.value)}
                      className="h-3.5 w-3.5 rounded border-border accent-primary"
                    />
                    <span className={checked ? "text-foreground" : "text-muted-foreground"}>
                      {opt.label}
                    </span>
                  </label>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
