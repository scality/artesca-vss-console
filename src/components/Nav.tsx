"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileVideo,
  LayoutDashboard,
  Network,
  AlertTriangle,
  Camera,
  ListChecks,
  MessageSquare,
  Sliders,
  BookmarkCheck,
  KeyRound,
  ScrollText,
  Stethoscope,
  Settings,
  Info,
  Bot,
  Calculator,
  Cog,
  Search,
  HardDrive,
  BarChart3,
  ShieldCheck,
  Gauge,
  Cpu,
  ExternalLink,
} from "lucide-react";
import { useKiosk } from "./KioskProvider";
import { useAiFactoryUrl } from "./BoxModeProvider";
import { cn } from "@/lib/utils";
import { KIOSK_HIDDEN_ROUTES } from "@/lib/kiosk";

// Grouped nav: labeled sections for both presenter (Live / AI & Storage) and
// operator (Configure / System). Section headers hidden in kiosk mode.
const NAV_GROUPS: Array<{
  label: string;
  routes: Array<{ href: string; label: string; icon: typeof LayoutDashboard }>;
}> = [
  {
    label: "Live",
    routes: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/topology", label: "Topology", icon: Network },
      { href: "/incidents", label: "Incidents", icon: AlertTriangle },
      { href: "/cameras", label: "Cameras", icon: Camera },
    ],
  },
  {
    label: "AI & Storage",
    routes: [
      { href: "/search", label: "Search", icon: Search },
      { href: "/analytics", label: "Ask the Store", icon: BarChart3 },
      { href: "/chat", label: "VSS Chat", icon: Bot },
      { href: "/evidence", label: "Evidence", icon: ShieldCheck },
      { href: "/storage", label: "Storage", icon: HardDrive },
      { href: "/kvcache", label: "KV Cache", icon: Gauge },
    ],
  },
  {
    label: "Configure",
    routes: [
      { href: "/scenarios", label: "Scenarios", icon: ListChecks },
      { href: "/prompt", label: "VLM Prompt", icon: MessageSquare },
      { href: "/tuning", label: "Tuning", icon: Sliders },
      { href: "/agent", label: "Agent", icon: Cog },
      { href: "/test-footage", label: "Test Footage", icon: FileVideo },
      { href: "/profiles", label: "Profiles", icon: BookmarkCheck },
    ],
  },
  {
    label: "System",
    routes: [
      { href: "/secrets", label: "Secrets", icon: KeyRound },
      { href: "/logs", label: "Logs", icon: ScrollText },
      { href: "/diagnostics", label: "Diagnostics", icon: Stethoscope },
      { href: "/sizing-studio", label: "Sizing Studio", icon: Calculator },
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/about", label: "About", icon: Info },
    ],
  },
];

export function Nav() {
  const pathname = usePathname();
  const { kiosk } = useKiosk();
  const aiFactoryUrl = useAiFactoryUrl();

  const renderLink = (href: string, label: string, Icon: typeof LayoutDashboard) => {
    const active = pathname === href || (href !== "/" && pathname.startsWith(href));
    return (
      <Link
        key={href}
        href={href}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {label}
      </Link>
    );
  };

  return (
    <nav className="flex flex-col gap-0.5 p-2">
      {NAV_GROUPS.map((group) => {
        const items = kiosk
          ? group.routes.filter((r) => !KIOSK_HIDDEN_ROUTES.includes(r.href))
          : group.routes;
        if (items.length === 0) return null;
        return (
          <div key={group.label} className="flex flex-col gap-0.5">
            {!kiosk && (
              <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                {group.label}
              </div>
            )}
            {items.map((r) => renderLink(r.href, r.label, r.icon))}
          </div>
        );
      })}
      {/* The sibling app that switches the box's GPUs between VSS and the LLM.
          Outside NAV_GROUPS on purpose: it is not a console page, and the
          ISV-ARCH-05 generator reads NAV_GROUPS as the page list. Shown in
          every box mode. */}
      <div className="mt-2 border-t border-border pt-2">
        <a
          href={aiFactoryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Cpu className="h-4 w-4 shrink-0" />
          AI Factory
          <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0" aria-label="opens in a new tab" />
        </a>
      </div>
    </nav>
  );
}
