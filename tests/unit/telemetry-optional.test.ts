// The optional telemetry install (ISVD-605/607). @sentry/nextjs pulls @sentry/cli
// under FSL-1.1-MIT — source-available, not open source — so a default clone of
// this public repository must not pull it.
//
// Three resolvers have to agree about whether the SDK is installed, and the tests
// are the only place that can hold them together: next.config.js decides the
// build, vitest.config.ts decides these tests, and tsc is suppressed on one line.
// Getting it wrong fails only on a machine without the SDK — never on the author's.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { createRequire } from "module";

const ROOT = path.resolve(__dirname, "../..");
const req = createRequire(import.meta.url);
const optional = req(path.join(ROOT, "telemetry-optional.cjs")) as {
  PACKAGE: string;
  VERSION: string;
  NOOP_MODULE: string;
  telemetryInstalled: () => boolean;
};

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("the SDK is not a declared dependency", () => {
  it("appears in no dependency field of package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      expect(
        Object.keys(pkg[field] ?? {}),
        `${optional.PACKAGE} must not be in ${field} — a default clone would pull FSL-licensed @sentry/cli`,
      ).not.toContain(optional.PACKAGE);
    }
  });

  it("appears nowhere in the lockfile", () => {
    // optionalDependencies and required peerDependencies are BOTH installed by
    // default (measured, npm 11.12.1), so "declared but optional" is not a way to
    // keep a clone clean. The lockfile is the check that cannot be argued with.
    expect(read("package-lock.json")).not.toContain(optional.PACKAGE);
  });

  it("pins an exact version, because --no-save writes no lockfile entry", () => {
    expect(optional.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("one presence check, read by every resolver", () => {
  it("next.config.js and vitest.config.ts both read telemetry-optional.cjs", () => {
    for (const cfg of ["next.config.js", "vitest.config.ts"]) {
      expect(read(cfg), `${cfg} must not decide presence for itself`).toContain(
        "telemetry-optional.cjs",
      );
    }
  });

  it("neither config hardcodes the package name or the stub path", () => {
    // Both must come from the shared module, or the three answers drift.
    for (const cfg of ["next.config.js", "vitest.config.ts"]) {
      const src = read(cfg);
      const quoted = src.match(/["']@sentry\/nextjs["']/g) ?? [];
      expect(quoted, `${cfg} hardcodes the package name`).toHaveLength(0);
      expect(src, `${cfg} hardcodes the stub path`).not.toContain("telemetry-noop.ts\"");
    }
  });

  it("the stub module the check names actually exists", () => {
    expect(existsSync(path.join(ROOT, optional.NOOP_MODULE))).toBe(true);
  });
});

describe("the boundary is the only file naming the package", () => {
  it("no source file imports the SDK directly", () => {
    // Everything imports @/lib/telemetry, so absence is one resolution problem
    // rather than seven. Measured before this change: six files imported it, and
    // src/lib/error-bridge.ts was the easy one to miss — it is application code,
    // not an instrumentation hook.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of req("fs").readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          const rel = path.relative(ROOT, p);
          if (rel === path.join("src", "lib", "telemetry.ts")) continue;
          if (readFileSync(p, "utf8").includes(`"${optional.PACKAGE}"`)) offenders.push(rel);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    for (const f of ["sentry.server.config.ts", "sentry.edge.config.ts"]) {
      if (read(f).includes(`"${optional.PACKAGE}"`)) offenders.push(f);
    }
    expect(offenders, "import from @/lib/telemetry instead").toEqual([]);
  });
});

describe("the stub satisfies everything the tree calls", () => {
  it("exports every Sentry API used anywhere in the source", () => {
    // The failure this prevents: a newly used API resolves fine for the author
    // (who has the SDK) and is undefined on a clone that does not — at runtime,
    // in whatever page happened to call it.
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const e of req("fs").readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/\bSentry\.([a-zA-Z_]\w*)/g)) {
            used.add(m[1]);
          }
        }
      }
    };
    walk(path.join(ROOT, "src"));
    for (const f of ["sentry.server.config.ts", "sentry.edge.config.ts"]) {
      for (const m of read(f).matchAll(/\bSentry\.([a-zA-Z_]\w*)/g)) used.add(m[1]);
    }
    expect(used.size, "found no Sentry.* usage at all — the scan is broken").toBeGreaterThan(0);

    const stub = read(optional.NOOP_MODULE);
    const boundary = read("src/lib/telemetry.ts");
    for (const api of used) {
      expect(stub, `telemetry-noop.ts does not export ${api}`).toMatch(
        new RegExp(`function ${api}\\b|const ${api}\\b`),
      );
      expect(boundary, `src/lib/telemetry.ts does not re-export ${api}`).toMatch(
        new RegExp(`\\b${api}\\b`),
      );
    }
  });
});
