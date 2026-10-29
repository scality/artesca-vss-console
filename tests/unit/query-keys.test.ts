// One QueryClient serves every page, so two useQuery calls that share a key
// share one cache entry. When their queryFns return different shapes, the page
// visited second renders the first page's data: /scenarios read the camera
// panel's Scenario[] as { scenarios } and showed an empty table (a save from
// there would write only the new rows); /prompt read the tuning page's { model }
// and showed an empty editor. Same key ⇒ same queryFn.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === "api" ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe("react-query keys", () => {
  it("every useQuery sharing a key fetches with the same queryFn", () => {
    const byKey = new Map<string, Map<string, string[]>>();
    const re = /^( *)queryKey: (\[[^\]\n]*\]),\r?\n\1queryFn: ([\s\S]*?)\r?\n\1\}/gm;
    for (const file of sources(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(re)) {
        const fn = m[3].replace(/\s+/g, " ");
        const fns = byKey.get(m[2]) ?? new Map<string, string[]>();
        fns.set(fn, [...(fns.get(fn) ?? []), path.relative(SRC, file)]);
        byKey.set(m[2], fns);
      }
    }
    expect(byKey.size).toBeGreaterThan(15);
    for (const [key, fns] of byKey) {
      expect(fns.size, `${key} in ${[...fns.values()].flat().join(", ")}`).toBe(1);
    }
  });
});
