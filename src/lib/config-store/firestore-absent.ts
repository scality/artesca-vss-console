/**
 * Stand-in for `@google-cloud/firestore` when the optional SDK is not installed.
 *
 * `next.config.js` and `vitest.config.ts` alias the package specifier here (see
 * firestore-optional.cjs), so the build resolves and the Firestore store's module
 * still type-checks and imports. The difference from the telemetry stand-in is
 * that this one **refuses** rather than doing nothing: telemetry not reporting is
 * a degraded build, but a config store that silently accepts writes and drops
 * them would lose an operator's camera configuration with no error anywhere.
 *
 * Reaching this constructor means a deployment asked for `CONSOLE_CONFIG_STORE=firestore`
 * from an image built without `WITH_FIRESTORE=1`. The message names the fix and
 * the default backend, because the second is usually the right answer.
 */
export class Firestore {
  constructor(_opts?: unknown) {
    throw new Error(
      "CONSOLE_CONFIG_STORE=firestore, but the @google-cloud/firestore SDK is not installed in " +
        "this build. Either run `npm run enable-firestore` (or rebuild the image with " +
        "--build-arg WITH_FIRESTORE=1), or leave CONSOLE_CONFIG_STORE unset to use the " +
        "default YAML file store.",
    );
  }
}
