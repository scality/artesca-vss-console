/**
 * `src/components/monaco.ts` exists so Monaco is served by the app instead of
 * fetched from cdn.jsdelivr.net (ISVD-586). Nothing enforces that at runtime: a
 * component importing `@monaco-editor/react` directly still renders an editor,
 * and still works on a laptop with egress. It fails only on a cluster without
 * it — the showroom — where the editor never loads at all.
 *
 * So the guard is here instead.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");
const ENTRY = path.join(SRC, "components", "monaco.ts");

/** Read from source rather than imported: importing the entry point would pull
 *  in @monaco-editor/react and configure a loader this test has no use for. */
function loaderPath(): string {
  const m = readFileSync(ENTRY, "utf8").match(/MONACO_VS_PATH = "([^"]+)"/);
  if (!m) throw new Error("MONACO_VS_PATH is not declared in components/monaco.ts");
  return m[1];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("Monaco has one entry point", () => {
  it("is imported only through src/components/monaco.ts", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => f !== ENTRY)
      .filter((f) => readFileSync(f, "utf8").includes("@monaco-editor/react"))
      .map((f) => path.relative(SRC, f));

    expect(offenders, [
      "These import @monaco-editor/react directly, which loads Monaco from",
      "cdn.jsdelivr.net and breaks the editor on a cluster with no egress.",
      'Import { MonacoEditor, DiffEditor } from "@/components/monaco" instead.',
    ].join(" ")).toEqual([]);
  });

  it("configures the loader with an app-served path, not a CDN", () => {
    expect(readFileSync(ENTRY, "utf8")).toMatch(/loader\.config\(/);
    // A `vs` path carrying a scheme is a CDN again, whichever host it names.
    expect(loaderPath()).not.toMatch(/^\w+:|^\/\//);
    expect(loaderPath().startsWith("/")).toBe(true);
  });

  it("qualifies that path with the origin before handing it to the loader", () => {
    // Monaco runs language services in workers created from a blob URL, which
    // has no base for a relative path to resolve against — so a root-relative
    // `paths.vs` leaves every worker unable to load itself. The editor still
    // renders and still accepts typing, so nothing looks wrong; JSON validation
    // and formatting are simply gone. Shortening this back to the bare constant
    // is the plausible mistake, and it is silent.
    // tests/e2e/monaco.spec.ts proves the worker end of it for real.
    const entry = readFileSync(ENTRY, "utf8");
    expect(entry).toMatch(/window\.location\.origin/);
    expect(entry).not.toMatch(/loader\.config\(\{\s*paths:\s*\{\s*vs:\s*MONACO_VS_PATH\s*\}/);
  });

  it("resolves to a file copy-monaco.mjs actually writes", () => {
    // The script's destination and the loader's path are two halves of one
    // arrangement. If they disagree, Monaco 404s at runtime and nothing else
    // notices — least of all a laptop, which would fall back to the CDN.
    // Idempotent: a no-op once the stamped version matches.
    execFileSync(process.execPath, [path.join(ROOT, "scripts/copy-monaco.mjs")], {
      cwd: ROOT,
      stdio: "pipe",
    });

    const served = path.join(ROOT, "public", loaderPath(), "loader.js");
    expect(
      existsSync(served),
      `the loader is configured for ${loaderPath()}, but ${path.relative(ROOT, served)} was not written`
    ).toBe(true);
  });
});
