// The E2E suite runs against a production `next start`, which reads no .env
// file in CI. Everything the app needs therefore has to be declared on the
// workflow step — and nothing checked that, so the two drifted: a laptop run
// picked `AUTH_SECRET` and `CONSOLE_DISABLE_AUTH` out of `.env.local` and
// passed, while CI supplied neither. It stayed green only because the
// @auth/core in the lockfile answered a missing secret by letting every request
// through; a version that stops doing that turns 26 specs red at once, with the
// failure reported against whichever page each spec happened to open.
//
// These two assertions tie the workflow to the things that decide whether a
// page is reachable at all, so the gap is a failed unit test rather than a
// 20-minute E2E run whose output blames Monaco, cameras and diagnostics.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const WORKFLOW = path.join(ROOT, ".github/workflows/build-console.yml");

/**
 * The `env:` block of the `Playwright E2E` step, as a name -> value map.
 *
 * Hand-parsed rather than pulled in with a YAML dependency: this needs one
 * block of one step, and the shape it accepts is pinned by the test below that
 * feeds it the real file.
 */
function e2eStepEnv(): Record<string, string> {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const stepIdx = lines.findIndex((l) => /^\s*- name: Playwright E2E\s*$/.test(l));
  expect(stepIdx, "no 'Playwright E2E' step in the workflow").toBeGreaterThan(-1);

  const envIdx = lines.findIndex((l, i) => i > stepIdx && /^\s*env:\s*$/.test(l));
  expect(envIdx, "the E2E step declares no env block").toBeGreaterThan(stepIdx);

  const env: Record<string, string> = {};
  for (const line of lines.slice(envIdx + 1)) {
    if (/^\s*(#|$)/.test(line)) continue; // comment or blank — keep reading
    const m = /^\s{10,}([A-Z_][A-Z0-9_]*):\s*(.+?)\s*$/.exec(line);
    if (!m) break; // dedented past the block, or the next step began
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

describe("the E2E workflow step supplies what a production server needs", () => {
  // src/instrumentation.ts owns the list of variables the app refuses to run
  // properly without. Reading it here rather than restating it means adding one
  // there fails this test until CI is given it, instead of failing every spec.
  it("sets every env var src/instrumentation.ts declares required", () => {
    const src = readFileSync(path.join(ROOT, "src/instrumentation.ts"), "utf8");
    const declared = /const required = \[([^\]]*)\]/.exec(src);
    expect(declared, "could not find the `required` list in instrumentation.ts").not.toBeNull();

    const required = [...declared![1].matchAll(/"([A-Z_][A-Z0-9_]*)"/g)].map((m) => m[1]);
    expect(required.length, "the required list parsed as empty").toBeGreaterThan(0);

    const env = e2eStepEnv();
    for (const key of required) {
      expect(env[key], `${key} is required by the app but unset in the E2E step`).toBeTruthy();
    }
  });

  // The specs stub /api/auth/session with page.route, which is a browser-level
  // intercept. src/proxy.ts runs on the server and never sees it, so without
  // the bypass every guarded page answers 307 to /sign-in and the assertion
  // fails wherever that spec looked — never at the redirect.
  it("bypasses the sign-in gate, which the page.route stubs cannot do", () => {
    expect(e2eStepEnv().CONSOLE_DISABLE_AUTH).toBe("true");
  });
});
