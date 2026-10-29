// KioskHero renders only in kiosk mode, and proxy.ts redirects a kiosk visitor
// from any page outside KIOSK_ALLOWED_ROUTES back to "/". So every link on the
// hero must lead to an allowed page; the "Cameras watched" tile pointed at the
// hidden /cameras and bounced visitors to the hero they had just left.
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KioskHero } from "@/components/overview/KioskHero";
import { isKioskAllowed } from "@/lib/kiosk";
import type { Incident, OverviewSnapshot } from "@/lib/types";
import overview from "../fixtures/overview.json";
import incidents from "../fixtures/incidents.json";

describe("KioskHero links", () => {
  it("every link leads to a page kiosk mode serves", () => {
    const html = renderToStaticMarkup(
      <KioskHero
        overview={overview as unknown as OverviewSnapshot}
        extras={{ archiveTotal: 12, last24h: 3, recent: incidents as Incident[], warnings: [] }}
      />,
    );
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    // Four story tiles, "See all" and one row per recent incident.
    expect(hrefs.length).toBe(5 + incidents.length);
    for (const href of hrefs) {
      expect(isKioskAllowed(new URL(href, "http://console.invalid").pathname), href).toBe(true);
    }
  });
});
