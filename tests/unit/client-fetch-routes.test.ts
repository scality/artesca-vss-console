// A button whose fetch targets a path with no route under src/app/api answers
// 404 on every click. FeedList's Re-register and Disable did, for their whole
// life. Every literal /api/... URL a client file fetches must resolve to a route.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
const API = path.join(SRC, "app/api");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

// Route dirs as segment lists, e.g. ["cameras", "[id]", "restart"].
const routes = files(API)
  .filter((p) => path.basename(p) === "route.ts")
  .map((p) => path.relative(API, path.dirname(p)).split(path.sep));

function resolves(url: string): boolean {
  const segs = url.replace(/^\/api\//, "").split(/[?#]/)[0].replace(/\/$/, "").split("/");
  return routes.some((r) => {
    if (r.at(-1)?.startsWith("[...")) return segs.length >= r.length && r.slice(0, -1).every((s, i) => s.startsWith("[") || s === segs[i]);
    return r.length === segs.length && r.every((s, i) => s.startsWith("[") || s === segs[i] || segs[i] === ":param");
  });
}

describe("client fetch targets", () => {
  it("every /api URL a client file fetches has a route", () => {
    const missing: string[] = [];
    for (const f of files(SRC).filter((p) => /\.tsx?$/.test(p) && !p.startsWith(API) && !/\.test\./.test(p))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/fetch\(\s*[`"'](\/api\/[^`"']*)[`"']/g)) {
        // `/${id}` is a path segment; `${qs}` glued onto one is a query string.
        const url = m[1].replace(/\/\$\{[^}]*\}/g, "/:param").replace(/\$\{[^}]*\}/g, "");
        if (!resolves(url)) missing.push(`${path.relative(SRC, f)}: ${m[1]}`);
      }
    }
    expect(routes.length).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});
