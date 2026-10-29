// The AI Factory link (sidebar, pause banner, kiosk notice) is shown only when
// AI_FACTORY_URL is set. It used to fall back to http://localhost:4090, which
// is dead for every operator who does not hold the AI Factory's own tunnel.
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoxMode } from "@/lib/box-mode-shared";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { Nav } from "@/components/Nav";
import { BoxModeBanner } from "@/components/BoxModeBanner";
import { BoxModeProvider } from "@/components/BoxModeProvider";

const PAUSED: BoxMode = { mode: "llm", pinned: false, updatedAt: null, source: "configmap", reason: null };
const SET = "http://ai-factory.example:4090";

const nav = (url: string | null) =>
  renderToStaticMarkup(
    <BoxModeProvider aiFactoryUrl={url}>
      <Nav />
    </BoxModeProvider>,
  );
const banner = (url: string | null, kiosk: boolean) =>
  renderToStaticMarkup(<BoxModeBanner boxMode={PAUSED} aiFactoryUrl={url} kiosk={kiosk} />);

describe("AI Factory link", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is absent from the sidebar, the banner and the kiosk notice when no URL is configured", () => {
    expect(nav(null)).not.toContain("AI Factory");
    expect(banner(null, false)).not.toContain("Open the AI Factory");
    expect(banner(null, true)).not.toContain("Open the AI Factory");
    // The pause itself is still announced.
    expect(banner(null, true)).toContain("VSS paused");
  });

  it("links to the configured URL in all three places", () => {
    expect(nav(SET)).toContain(`href="${SET}"`);
    expect(banner(SET, false)).toContain(`href="${SET}"`);
    expect(banner(SET, true)).toContain(`href="${SET}"`);
  });

  it("CLUSTER.aiFactory.url is null unless AI_FACTORY_URL is an absolute http(s) URL", async () => {
    vi.stubEnv("AI_FACTORY_URL", "");
    expect((await import("@/lib/cluster-refs")).CLUSTER.aiFactory.url).toBeNull();
    vi.resetModules();
    vi.stubEnv("AI_FACTORY_URL", "javascript:alert(1)");
    expect((await import("@/lib/cluster-refs")).CLUSTER.aiFactory.url).toBeNull();
    vi.resetModules();
    vi.stubEnv("AI_FACTORY_URL", SET);
    expect((await import("@/lib/cluster-refs")).CLUSTER.aiFactory.url).toBe(SET);
  });
});
