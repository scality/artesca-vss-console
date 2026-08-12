#!/usr/bin/env node
/**
 * Install the optional Firestore SDK.
 *
 *   npm run enable-firestore
 *
 * `@google-cloud/firestore` is in no dependency field: the config store's default
 * backend is a YAML file, and a default clone should not pull a GCP client library,
 * gRPC and protobufjs to run code paths it never reaches. See firestore-optional.cjs
 * for why it is kept available rather than deleted.
 *
 * `--no-save`, so neither package.json nor package-lock.json changes — the opt-in is
 * a property of an install, not of the source. That is also its cost: npm writes no
 * lockfile entry, so the subtree gets no integrity hash and no reproducible
 * resolution, and VERSION in firestore-optional.cjs is the only thing pinning it.
 *
 * ⚠ An optional peerDependency does NOT work here and is the obvious thing to reach
 * for — measured on npm 11.12.1 while doing the same for the telemetry SDK:
 * `peerDependenciesMeta.optional` keeps it out of a default install and then nothing
 * can put it back. `optionalDependencies` fails the other way; npm installs those by
 * default, which is the whole thing being avoided.
 */
import { spawnSync } from "child_process";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { PACKAGE, VERSION, firestoreInstalled } = require_("../firestore-optional.cjs");

const spec = `${PACKAGE}@${VERSION}`;

if (firestoreInstalled()) {
  console.log(`enable-firestore: ${PACKAGE} already resolvable — nothing to do`);
  process.exit(0);
}

console.log(`enable-firestore: installing ${spec} (--no-save)`);
const res = spawnSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", spec], {
  stdio: "inherit",
});

if (res.status !== 0) {
  console.error(`enable-firestore: npm install failed (exit ${res.status})`);
  process.exit(res.status ?? 1);
}

// Read the result back rather than trusting the exit code — npm exits 0 in cases
// where it decided not to install anything.
//
// In a FRESH process, not by calling firestoreInstalled() here: Node caches failed
// resolutions in Module._pathCache, so this process already recorded the miss from
// the check above and would report absent however well the install went. Measured
// on the telemetry opt-in, where it did exactly that over a working install.
const check = spawnSync(process.execPath, ["-e", `require.resolve(${JSON.stringify(PACKAGE)})`], {
  stdio: "ignore",
});
if (check.status !== 0) {
  console.error(`enable-firestore: npm reported success but ${PACKAGE} is still not resolvable`);
  process.exit(1);
}

console.log(
  `enable-firestore: ${spec} installed. Set CONSOLE_CONFIG_STORE=firestore and FIRESTORE_PROJECT_ID to use it.`,
);
