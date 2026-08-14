/**
 * Every environment variable the app refuses to run without must be one a deploy
 * actually provisions.
 *
 * This is the question four separate gates all failed to ask about the EC2
 * security-group panel (ISVD-610). Its write paths read `CONSOLE_SG_ID` while the
 * `console-aws` Secret, `.env.example`, `deploy-console.sh` in scality/isv-labs,
 * `scripts/smoke-test-console.sh` and this console's own rotation route all
 * carried `VSS_INSTANCE_SG_ID` — so the panel answered
 * `500 CONSOLE_SG_ID env var not configured` on every deployment it ran on, for
 * its whole life. The route unit tests set the variable themselves. The smoke
 * test provisioned the real name and never called the route. The E2E spec
 * intercepted the request in the browser. `docs/console-config-validation.md`
 * listed the Secret's keys, which were correct — validating the Secret can never
 * reveal that the code reads a different name.
 *
 * Each gate checked one side. This compares the two sides.
 *
 * ⚠ Scoped to the names `src/instrumentation.ts` declares required, which is the
 * only place this console states that a variable is mandatory. It is not
 * repo-wide because separating a *required* read from an optional override is not
 * syntactic: measured 2026-08-14, 136 env names are read across `src/` and 76 are
 * unprovisioned optional overrides, with absence handled in at least five shapes
 * — `?? default`, `|| default`, a ternary on the name, `!!name` as a feature flag,
 * and assign-then-`if`. In `(FIRESTORE_PROJECT_ID ?? GOOGLE_CLOUD_PROJECT)?.trim()`
 * the fallback is the *left* operand, so it does not even follow the name it
 * guards; a heuristic scan flagged 6 candidates and all 6 handled absence
 * correctly. Widening this means routing required reads through one accessor so
 * the list is a consequence of the code — ISVD-672.
 *
 * tests/unit/e2e-workflow-env.test.ts reads the same declaration and holds the CI
 * workflow to it. Together: what the app requires must be set both in CI and in
 * something an operator applies.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** Files that declare what a deployment supplies. */
const PROVISIONERS = [
  "k8s/10-secrets.yaml.example",
  "k8s/11-configmap-env.yaml",
  ".env.example",
];

function provisionedNames(): Set<string> {
  const names = new Set<string>();
  for (const f of PROVISIONERS) {
    // Commented-out lines count: `# OBJECTSTORE_REGION=` documents the name, and
    // is how an operator learns it exists.
    for (const m of readFileSync(f, "utf8").matchAll(
      /^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*[:=]/gm
    )) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * The names the app declares mandatory. Parsed from `src/instrumentation.ts`
 * rather than restated here — a second copy beside the code is the shape that
 * drifts, and drift is the whole subject of this file.
 */
function requiredNames(): string[] {
  const src = readFileSync("src/instrumentation.ts", "utf8");
  const declared = /const required = \[([^\]]*)\]/.exec(src);
  expect(
    declared,
    "could not find the `required` list in src/instrumentation.ts — if it moved, this test is now checking nothing"
  ).not.toBeNull();
  return [...declared![1].matchAll(/"([A-Z_][A-Z0-9_]*)"/g)].map((m) => m[1]);
}

describe("the app's required env vars are provisioned", () => {
  it("parses a non-empty required list, so the check is not vacuous", () => {
    // Without this, the assertion below passes just as well when the parse
    // matches nothing — which is how a check comes to look like coverage while
    // asking no question at all.
    expect(requiredNames().length).toBeGreaterThan(0);
  });

  it("every required name is one a deploy supplies", () => {
    const provisioned = provisionedNames();
    const gaps = requiredNames().filter((n) => !provisioned.has(n));

    expect(
      gaps,
      `Declared required in src/instrumentation.ts and supplied by none of ` +
        `${PROVISIONERS.join(", ")}. An operator following those files gets a pod ` +
        `that logs "missing env vars" and refuses requests. Add the name, or read ` +
        `the name that is already there.`
    ).toEqual([]);
  });

  // The specific trap this caught when it was repointed here: `console-auth`
  // carried only `NEXTAUTH_SECRET`, which Auth.js v5 reads nothing from, so the
  // example manifest produced a pod that refused every request. k8s/README.md had
  // it as a *troubleshooting row* rather than a fixed example.
  it("provisions AUTH_SECRET, the name Auth.js actually reads", () => {
    expect(provisionedNames().has("AUTH_SECRET")).toBe(true);
  });

  // The EC2 panel is gone (ISVD-610), and with it the last consumer of the
  // `console-aws` Secret. Neither name should reappear in a manifest without the
  // code that reads it coming back too.
  it("provisions neither EC2 security-group name", () => {
    const provisioned = provisionedNames();
    expect(provisioned.has("CONSOLE_SG_ID")).toBe(false);
    expect(provisioned.has("VSS_INSTANCE_SG_ID")).toBe(false);
  });
});
