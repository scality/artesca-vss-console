"use client";

import { useKiosk } from "./KioskProvider";
import { Nav } from "./Nav";
import { PortalHeader } from "./brand/PortalHeader";
import { cn } from "@/lib/utils";

interface ShellProps {
  children: React.ReactNode;
  className?: string;
}

export function Shell({ children, className }: ShellProps) {
  const { kiosk } = useKiosk();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {!kiosk && (
        <PortalHeader eyebrow="ARTESCA × Pyramid × NVIDIA VSS" homeHref="/">
          <span
            className="ml-auto shrink-0 rounded bg-brand-indigo/40 px-1.5 py-0.5 text-[10px] font-semibold text-brand-teal-light"
            style={{ fontFamily: "var(--font-display)" }}
          >
            :8800
          </span>
        </PortalHeader>
      )}

      <div className="flex flex-1">
        {!kiosk && (
          <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-brand-white">
            <div className="flex-1 overflow-y-auto">
              <Nav />
            </div>
          </aside>
        )}

        <main className={cn("flex-1 p-6", className)}>{children}</main>
      </div>
    </div>
  );
}
