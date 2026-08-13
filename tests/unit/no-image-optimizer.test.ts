// ISVD-609. The image is built without `sharp`, so `next/image` must stay unused.
//
// sharp is an optionalDependency of `next`, not ours, and `output: standalone`
// traces it into the shipped tree whether or not anything imports next/image —
// measured on next@16.2.11: 10.6 MB, including `@img/sharp-libvips-*` under
// LGPL-3.0-or-later, the only copyleft licence in the production tree of a
// repository that is going public. The Dockerfile therefore deletes it after
// `npm ci` and before `next build`.
//
// That leaves a trap this test exists to close: `<Image>` type-checks, builds and
// passes every test on a laptop, because a local `npm ci` still installs sharp.
// It would fail only in the container, at runtime, on whatever page rendered it —
// and `images: { unoptimized: true }` is not a fix, since it does not restore the
// optimizer, it silently serves the original bytes instead.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

describe("the image optimizer is not used", () => {
  it("nothing imports next/image", () => {
    // Matches the import, not the string: `src/proxy.ts` legitimately names
    // `_next/image` in its middleware matcher, and a component comment explains
    // why it uses a plain <img> instead. Neither reaches the optimizer.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      if (/(?:from|import\()\s*["']next\/image["']/.test(src)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(
      offenders,
      "sharp is removed from the image (Dockerfile, ISVD-609) — use a plain <img>, " +
        "or restore sharp and re-measure the licence position first",
    ).toEqual([]);
  });

  it("the Dockerfile still removes it", () => {
    // The other half: if the removal is dropped, the test above becomes a rule
    // with nothing behind it, and 10.6 MB of LGPL returns to the image silently.
    const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/rm -rf node_modules\/sharp node_modules\/@img/);
  });

  it("sharp is not a declared dependency of this project", () => {
    // It never was — it arrives through `next`. Declaring it would put it back in
    // the trace and make the Dockerfile line a lie. The `overrides` entry is not a
    // declaration: it pins the version npm resolves for next's optional dep, which
    // is what keeps the libvips CVEs out of a local install.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      expect(Object.keys(pkg[field] ?? {}), `sharp must not be in ${field}`).not.toContain("sharp");
    }
  });
});
