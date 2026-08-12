/**
 * Is the optional telemetry SDK installed, and what stands in for it when it is not.
 *
 * `@sentry/nextjs` is deliberately absent from every dependency field in
 * package.json, because it pulls `@sentry/cli` under FSL-1.1-MIT — the Functional
 * Source License, source-available with a non-compete restriction rather than
 * open source. Measured: with it declared, `node_modules` holds 2 FSL packages;
 * without, 0. This repository is public, so a default clone must pull none.
 *
 * Three separate module resolvers have to agree about that presence, and each
 * fails differently if it disagrees:
 *
 *   next.config.js    the build — an unresolvable import is a build error
 *   vitest.config.ts  the unit tests — vitest resolves modules itself and does
 *                     NOT honour next.config.js's turbopack.resolveAlias
 *   tsc               suppressed with a ts-ignore on the single boundary import
 *
 * Both configs read this file so there is one answer rather than three. A test
 * pins them to it: three copies of one rule is the shape this repository has been
 * bitten by repeatedly.
 *
 * CommonJS on purpose — next.config.js is CJS and `require`s it directly.
 */

const PACKAGE = "@sentry/nextjs";

/**
 * Exact version the opt-in installs. Exact, not a range: the install path is
 * `npm install --no-save`, which writes no lockfile entry, so this string is the
 * only thing pinning the resolution. A range here would make two builds of the
 * same commit disagree about what they shipped.
 *
 * ⚠ Bumping this is not covered by the lockfile or by `npm audit` on a default
 * clone — nothing here resolves it until someone opts in. Check the advisory
 * state deliberately when changing it.
 */
const VERSION = "10.65.0";

/** Path the specifier is aliased to when the SDK is absent. Relative to the repo root. */
const NOOP_MODULE = "./src/lib/telemetry-noop.ts";

/**
 * True when the SDK can actually be resolved.
 *
 * `require.resolve` rather than reading package.json: what matters is whether the
 * module loads, not whether someone wrote it down. MODULE_NOT_FOUND is the only
 * error that means "absent" — anything else (a corrupt install, a permissions
 * problem) is rethrown, because silently treating it as absent would compile
 * telemetry out of a build that was meant to have it.
 */
function telemetryInstalled() {
  try {
    require.resolve(PACKAGE);
    return true;
  } catch (err) {
    if (err && err.code === "MODULE_NOT_FOUND") return false;
    throw err;
  }
}

module.exports = { PACKAGE, VERSION, NOOP_MODULE, telemetryInstalled };
