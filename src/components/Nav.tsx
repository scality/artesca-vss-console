"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Network,
  AlertTriangle,
  Camera,
  ListChecks,
  MessageSquare,
  Sliders,
  Database,
  BookmarkCheck,
  KeyRound,
  ScrollText,
  Stethoscope,
  Settings,
  Info,
  Bot,
  Calculator,
  Wrench,
} from "lucide-react";
import { useKiosk } from "./KioskProvider";
import { cn } from "@/lib/utils";
import { KIOSK_HIDDEN_ROUTES } from "@/lib/kiosk";

const ALL_ROUTES = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/topology", label: "Topology", icon: Network },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/chat", label: "VSS Chat", icon: Bot },
  { href: "/capabilities", label: "Capabilities", icon: Wrench },
  { href: "/cameras", label: "Cameras", icon: Camera },
  { href: "/scenarios", label: "Scenarios", icon: ListChecks },
  { href: "/prompt", label: "VLM Prompt", icon: MessageSquare },
  { href: "/tuning", label: "Tuning", icon: Sliders },
  { href: "/demo-data", label: "Demo Data", icon: Database },
  { href: "/profiles", label: "Profiles", icon: BookmarkCheck },
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/diagnostics", label: "Diagnostics", icon: Stethoscope },
  { href: "/sizing-studio", label: "Sizing Studio", icon: Calculator },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/about", label: "About", icon: Info },
];

export function Nav() {
  const pathname = usePathname();
  const { kiosk } = useKiosk();

  const routes = kiosk
    ? ALL_ROUTES.filter((r) => !KIOSK_HIDDEN_ROUTES.includes(r.href))
    : ALL_ROUTES;

  return (
    <nav className="flex flex-col gap-1 p-2">
      {routes.map(({ href, label, icon: Icon }) => {
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
      })}
    </nav>
  );
}
