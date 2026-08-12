#!/usr/bin/env node
/**
 * Install the optional telemetry SDK.
 *
 *   npm run enable-telemetry
 *
 * `@sentry/nextjs` is in no dependency field, because it pulls `@sentry/cli` under
 * FSL-1.1-MIT — source-available, not open source — and a default clone of a public
 * repository must not pull it. See telemetry-optional.cjs.
 *
 * `--no-save`, so neither package.json nor package-lock.json changes: the opt-in is
 * a property of an install, not of the source. That is also this path's cost —
 * npm writes no lockfile entry, so the SDK subtree gets no integrity hash and no
 * reproducible resolution. VERSION in telemetry-optional.cjs is exact for that
 * reason, and is the only thing pinning it.
 *
 * ⚠ Declaring it as an optional peerDependency does NOT work, and is the obvious
 * thing to reach for. Measured on npm 11.12.1: `peerDependenciesMeta.optional`
 * keeps it out of a default install, but then nothing can put it back —
 * `--no-save`, `--force`, `--include=peer` and `npm ci --include=peer` all leave it
 * absent, and the lockfile holds no entry to install from. `optionalDependencies`
 * fails the other way: npm installs those by default.
 */
import { spawnSync } from "child_process";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { PACKAGE, VERSION, telemetryInstalled } = require_("../telemetry-optional.cjs");

const spec = `${PACKAGE}@${VERSION}`;

if (telemetryInstalled()) {
  console.log(`enable-telemetry: ${PACKAGE} already resolvable — nothing to do`);
  process.exit(0);
}

console.log(`enable-telemetry: installing ${spec} (--no-save)`);
const res = spawnSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", spec], {
  stdio: "inherit",
});

if (res.status !== 0) {
  console.error(`enable-telemetry: npm install failed (exit ${res.status})`);
  process.exit(res.status ?? 1);
}

// Read the result back rather than trusting the exit code. npm exits 0 in cases
// where it decided not to install anything — which is exactly how the optional
// peerDependency attempt failed silently.
//
// In a FRESH process, not by calling telemetryInstalled() here: Node caches failed
// resolutions in Module._pathCache, so this process already recorded the miss from
// the check above and would report absent however well the install went. Measured:
// it did exactly that, reporting failure over a working 10.65.0 install.
const check = spawnSync(process.execPath, ["-e", `require.resolve(${JSON.stringify(PACKAGE)})`], {
  stdio: "ignore",
});
if (check.status !== 0) {
  console.error(
    `enable-telemetry: npm reported success but ${PACKAGE} is still not resolvable`,
  );
  process.exit(1);
}

console.log(`enable-telemetry: ${spec} installed. Set SENTRY_DSN to start reporting.`);
