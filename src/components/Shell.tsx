"use client";

import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
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
  const pathname = usePathname();

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

      {/* Kiosk exit — the only visible chrome in kiosk mode. A plain <a> (full
          navigation) so the middleware processes ?mode=normal and clears the
          HttpOnly kiosk cookie server-side. Corner-anchored to stay out of the
          showroom display. */}
      {kiosk && (
        <a
          href={`${pathname}?mode=normal`}
          title="Leave kiosk mode and return to the operator view"
          className="fixed bottom-4 right-4 z-50 inline-flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-card hover:text-foreground"
        >
          <LogOut className="h-3.5 w-3.5" />
          Exit kiosk
        </a>
      )}
    </div>
  );
}
