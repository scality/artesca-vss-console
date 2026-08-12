/**
 * Stands in for `@sentry/nextjs` when it is not installed.
 *
 * Same specifier, same shape, every call a no-op. `next.config.js` aliases the
 * package to this module for the build and `vitest.config.ts` does the same for
 * the unit tests, both reading `telemetry-optional.cjs` so they agree.
 *
 * The exported surface is exactly what this codebase calls — six functions,
 * enumerated from the source rather than guessed:
 *
 *   init  captureException  captureMessage  replayIntegration
 *   captureRouterTransitionStart  captureRequestError
 *
 * plus `withSentryConfig`, which only `next.config.js` uses and only when the real
 * SDK is present. A test asserts this list still matches what the tree calls, so
 * a newly used API fails a unit test rather than the build of a clone that has no
 * SDK — a failure the author would never see locally.
 */

export function init(): void {}

export function captureException(): undefined {
  return undefined;
}

export function captureMessage(): undefined {
  return undefined;
}

/** Sentry's replay integration object. Shape-compatible and inert. */
export function replayIntegration(): Record<string, never> {
  return {};
}

/**
 * Next calls this on every App Router navigation. It must exist and must be safe
 * to call — an absent export breaks navigation rather than telemetry.
 */
export function captureRouterTransitionStart(): void {}

/** Next's onRequestError hook. */
export function captureRequestError(): void {}

/** Only next.config.js reads this, and only in the SDK-present branch. */
export function withSentryConfig<T>(config: T): T {
  return config;
}
