/**
 * Is the optional Firestore SDK installed, and what stands in for it when it is not.
 *
 * `@google-cloud/firestore` is deliberately absent from every dependency field in
 * package.json. The reason is NOT licensing — it is Apache-2.0, like this project.
 * It is that the config store's default backend is a YAML file, so a default clone
 * pulls a GCP client library, gRPC and protobufjs (measured: ~17 MB across
 * `@google-cloud/firestore`, `google-gax`, `protobufjs` and `@grpc`) to run code
 * paths it never reaches. Anyone running the console outside the Scality labs has
 * no GCP project for it to talk to.
 *
 * Firestore stays *available* rather than being deleted, for two reasons that are
 * about this change rather than about the backend: it is where every existing lab's
 * cameras, prompt-sets and scenarios live today, so the migration reads through it;
 * and it is the rollback path if the file store turns out to be wrong on a live
 * showroom. `CONSOLE_CONFIG_STORE=firestore` selects it.
 *
 * The same three resolvers as the telemetry opt-in have to agree, and each fails
 * differently — see telemetry-optional.cjs, which this deliberately mirrors:
 *
 *   next.config.js    the build — an unresolvable import is a build error, and a
 *                     dynamic `await import()` of a bare specifier is still
 *                     resolved at build time
 *   vitest.config.ts  the unit tests — vitest resolves modules itself and does
 *                     NOT honour next.config.js's turbopack.resolveAlias
 *   tsc               suppressed with a ts-ignore on the single boundary import
 *
 * CommonJS on purpose — next.config.js is CJS and `require`s it directly.
 */

const PACKAGE = "@google-cloud/firestore";

/**
 * Exact version the opt-in installs. Exact, not a range, for the same reason as
 * the telemetry pin: the install path is `npm install --no-save`, which writes no
 * lockfile entry, so this string is the only thing pinning the resolution.
 *
 * ⚠ Not covered by the lockfile or by `npm audit` on a default clone — nothing
 * resolves it until someone opts in. Check advisories deliberately when bumping.
 */
const VERSION = "8.6.0";

/** Path the specifier is aliased to when the SDK is absent. Relative to the repo root. */
const NOOP_MODULE = "./src/lib/config-store/firestore-absent.ts";

/**
 * True when the SDK can actually be resolved.
 *
 * MODULE_NOT_FOUND is the only error that means "absent" — anything else (a
 * corrupt install, a permissions problem) is rethrown. Treating those as absent
 * would silently drop a deployment that selected `firestore` onto the stand-in,
 * whose whole job is to refuse.
 */
function firestoreInstalled() {
  try {
    require.resolve(PACKAGE);
    return true;
  } catch (err) {
    if (err && err.code === "MODULE_NOT_FOUND") return false;
    throw err;
  }
}

module.exports = { PACKAGE, VERSION, NOOP_MODULE, firestoreInstalled };
