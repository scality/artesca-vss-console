/**
 * Drop Node's DEP0169 (`url.parse()`) deprecation warning.
 *
 * @kubernetes/client-node's fetch client (IsomorphicFetchHttpLibrary) is backed
 * by node-fetch@2, whose Request constructor calls the legacy url.parse(). It
 * fires on every k8s API call (e.g. listAllPodsInNs behind the overview page and
 * its 5 s auto-refresh). The package is already at its latest release (1.4.0) and
 * still pins node-fetch@^2, so there is no upstream-clean version to bump to.
 * Filter only DEP0169 by code; every other warning passes through untouched.
 *
 * Lives in its own module so the Node-only `process.emitWarning` patch is pulled
 * in via dynamic import from instrumentation's nodejs branch and never lands in
 * the Edge runtime bundle.
 */

const globalForFilter = globalThis as unknown as { __dep0169Filtered?: boolean };

export function filterUrlParseDeprecation(): void {
  if (globalForFilter.__dep0169Filtered) return;
  globalForFilter.__dep0169Filtered = true;

  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const code =
      typeof rest[0] === "object" && rest[0] !== null
        ? (rest[0] as { code?: string }).code
        : typeof rest[1] === "string"
          ? rest[1]
          : undefined;
    if (code === "DEP0169") return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
