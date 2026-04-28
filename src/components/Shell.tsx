"use client";

import { useKiosk } from "./KioskProvider";
import { Nav } from "./Nav";
import { cn } from "@/lib/utils";

interface ShellProps {
  children: React.ReactNode;
  className?: string;
}

export function Shell({ children, className }: ShellProps) {
  const { kiosk } = useKiosk();

  return (
    <div className="flex min-h-screen bg-background">
      {!kiosk && (
        <aside className="flex w-60 shrink-0 flex-col border-r border-border">
          <div className="flex h-14 items-center border-b border-border px-4">
            <span className="text-sm font-semibold tracking-wide text-foreground">
              Scality VSS Console
            </span>
            <span className="ml-2 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              :8800
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <Nav />
          </div>
        </aside>
      )}

      <div className="flex flex-1 flex-col">
        {!kiosk && (
          <header className="flex h-14 items-center border-b border-border px-6">
            <span className="text-sm text-muted-foreground">
              ARTESCA × Pyramid × NVIDIA VSS
            </span>
          </header>
        )}

        <main className={cn("flex-1 p-6", className)}>{children}</main>
      </div>
    </div>
  );
}
