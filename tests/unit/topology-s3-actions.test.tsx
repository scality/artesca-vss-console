// @vitest-environment jsdom
//
// The topology S3 node's Actions tab had a "Test PUT" button that posted to
// /api/diagnostics/s3-write — a test the route never registered — so every
// click answered HTTP 400. No button there may post a diagnostic the route
// does not know.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { STORAGE_RENDERERS } from "@/components/topology/node-content/storage-renderers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routeSrc = readFileSync(path.resolve(__dirname, "../../src/app/api/diagnostics/[test]/route.ts"), "utf8");
const start = routeSrc.indexOf("const DIAGNOSTICS");
const ROUTE_IDS = [...routeSrc.slice(start, routeSrc.indexOf("};", start)).matchAll(/^\s+"([\w-]+)":/gm)].map((m) => m[1]);

describe("topology S3 actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("posts only diagnostics the route registers", async () => {
    const Actions = STORAGE_RENDERERS["artesca-s3"].actions!;
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          {Actions({ nodeId: "artesca-s3", runtimeState: undefined, snapshot: undefined })}
        </QueryClientProvider>,
      );
    });
    for (const b of [...container.querySelectorAll("button")]) {
      await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    }
    const diagnostics = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.startsWith("/api/diagnostics/"))
      .map((u) => u.slice("/api/diagnostics/".length));
    for (const id of diagnostics) expect(ROUTE_IDS, id).toContain(id);
  });
});
