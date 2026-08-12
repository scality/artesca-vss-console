/**
 * The only module in this tree that names `@sentry/nextjs`.
 *
 * Everything else imports from here, which turns the SDK's absence from seven
 * separate resolution failures into one. `telemetry-optional.cjs` explains why it
 * is optional and which resolvers have to agree.
 *
 * This is a capability boundary, not a compatibility shim: it does not preserve an
 * old name or an old call shape, it decides whether a capability is present. The
 * distinction matters because the house rule forbids the latter.
 *
 * Whether the SDK is installed is a different axis from whether a DSN is
 * configured, and both are real states. `src/lib/telemetry-config.ts` owns the
 * second one, and every `init` call is already guarded on it. Conflating them
 * would make "no DSN" indistinguishable from "no SDK".
 */

// The specifier resolves to the real SDK when installed, and to ./telemetry-noop
// when not — decided by next.config.js for the build and vitest.config.ts for the
// tests. tsc knows neither alias, so the import is suppressed.
//
// `ts-ignore` and not `ts-expect-error`: the error only exists when the package is
// absent, and an *unused* expect-error is itself an error, so expect-error would
// simply move the failure to the SDK-present case.
// @ts-ignore optional dependency, aliased when absent
import * as SDK from "@sentry/nextjs";

type AnyFn = (...args: never[]) => unknown;

/**
 * The surface this codebase actually uses. Narrow on purpose: it is the contract
 * `telemetry-noop.ts` has to satisfy, and a narrow one can be kept honest.
 */
interface TelemetrySurface {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, context?: unknown): unknown;
  captureMessage(message: string, context?: unknown): unknown;
  replayIntegration(options: Record<string, unknown>): unknown;
  captureRouterTransitionStart: AnyFn;
  captureRequestError: AnyFn;
}

const sdk = SDK as unknown as TelemetrySurface;

export const init = (options: Record<string, unknown>): void => sdk.init(options);

export const captureException = (error: unknown, context?: unknown): unknown =>
  sdk.captureException(error, context);

export const captureMessage = (message: string, context?: unknown): unknown =>
  sdk.captureMessage(message, context);

export const replayIntegration = (options: Record<string, unknown>): unknown =>
  sdk.replayIntegration(options);

export const captureRouterTransitionStart = sdk.captureRouterTransitionStart;

export const captureRequestError = sdk.captureRequestError;
