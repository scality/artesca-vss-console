/**
 * The environment variables the SG feature requires must be names a deploy
 * actually provisions.
 *
 * This is the question four separate gates all failed to ask. The whitelist
 * routes read `CONSOLE_SG_ID`; the Secret, `.env.example`, the deployer in
 * scality/isv-labs and the smoke test all provision `VSS_INSTANCE_SG_ID`.
 * Nothing compared the two, so the write path answered
 * `500 CONSOLE_SG_ID env var not configured` on every deployment it ran on:
 *
 *   - the route unit tests set `process.env.CONSOLE_SG_ID` themselves, proving
 *     the routes work against a name no deployment supplies;
 *   - the smoke test provisions `VSS_INSTANCE_SG_ID` and never calls the route;
 *   - the e2e spec intercepts `/api/settings/sg` in the browser, so nothing
 *     server-side runs;
 *   - docs/console-config-validation.md lists the Secret's keys, which were
 *     right — validating the Secret can never reveal that the code reads a
 *     different name.
 *
 * Each gate checked one side. This compares the two sides (ISVD-610).
 *
 * ⚠ Scoped to lib/ec2-sg.ts, and deliberately not repo-wide. A repo-wide
 * version needs to tell a *required* read from an optional override, and that
 * distinction is not syntactic: measured across src/, 136 env names are read and
 * 76 are unprovisioned optional overrides, with absence handled in at least five
 * shapes — `?? default`, `|| default`, a ternary on the name, `!!name` as a
 * feature flag, and assign-then-`if`. In `(FIRESTORE_PROJECT_ID ??
 * GOOGLE_CLOUD_PROJECT)?.trim()` the fallback is the *left* operand, so it does
 * not even follow the name it guards. A heuristic scan flagged 6 of those 6 as
 * required when all 6 handle absence correctly, and its misses would be false
 * negatives in the one direction that matters. Making this general means routing
 * required reads through one accessor so the list is a consequence of the code
 * rather than a second thing to remember — ISVD-672.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** Files that declare what a deployment supplies. */
const PROVISIONERS = [
  "k8s/10-secrets.yaml.example",
  "k8s/11-configmap-env.yaml",
  ".env.example",
];

const SG_MODULE = "src/lib/ec2-sg.ts";

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
 * Every env name lib/ec2-sg.ts reads. Derived from the module rather than
 * listed here — a hand-kept list beside the code is the shape that drifts, and
 * drift is what this test exists to catch.
 */
function sgModuleEnvReads(): string[] {
  const src = readFileSync(SG_MODULE, "utf8");
  return [...new Set([...src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]))];
}

describe("the SG feature's env contract", () => {
  it("reads at least one name, so the scan is not vacuously empty", () => {
    // Without this, everything below passes just as well when the scan matches
    // nothing — which is how a check comes to look like coverage while asking no
    // question at all.
    expect(sgModuleEnvReads().length).toBeGreaterThan(0);
  });

  it("every name it reads is one a deploy provisions", () => {
    const provisioned = provisionedNames();
    const gaps = sgModuleEnvReads().filter((n) => !provisioned.has(n));

    expect(
      gaps,
      `Read by ${SG_MODULE} and supplied by no manifest, so the feature behind ` +
        `each is dead on every deployment. Add the name to one of ` +
        `${PROVISIONERS.join(", ")} — or read the name that is already there.`
    ).toEqual([]);
  });

  it("requires both a group id and a region", () => {
    // Both halves are load-bearing: a group id with no region resolves to
    // whichever region the SDK defaults to, which is a live AWS account chosen
    // by omission. If either read disappears from the module, this fails.
    expect(sgModuleEnvReads()).toEqual(
      expect.arrayContaining(["VSS_INSTANCE_SG_ID", "AWS_REGION"])
    );
  });

  it("does not read the region from the object store's setting", () => {
    // OBJECTSTORE_REGION is the signing region of the S3 endpoint the storage
    // panels use. It is set on an ARTESCA cluster and says nothing about where
    // an EC2 instance lives, so reading it here would resolve an EC2 config out
    // of an unrelated value.
    expect(sgModuleEnvReads()).not.toContain("OBJECTSTORE_REGION");
  });

  it("no manifest provisions CONSOLE_SG_ID", () => {
    // The name the routes used to read, and the reason this file exists. Should
    // someone add it to a manifest to "fix" a symptom, this fails and points at
    // the real question: which name does the code read?
    expect(provisionedNames().has("CONSOLE_SG_ID")).toBe(false);
  });
});
