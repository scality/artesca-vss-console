import { defineConfig } from "vitest/config";
import path from "path";
import { createRequire } from "module";

// Telemetry is an optional install (see telemetry-optional.cjs). vitest resolves
// modules itself and does NOT honour next.config.js's turbopack.resolveAlias, so
// without this the whole suite fails to import src/lib/telemetry.ts on a clone
// that has no SDK — measured: 3 files, 5 tests. Both configs read the same
// presence check so they cannot disagree about it.
const { PACKAGE, NOOP_MODULE, telemetryInstalled } = createRequire(
  import.meta.url,
)("./telemetry-optional.cjs");

const telemetryAlias: Record<string, string> = telemetryInstalled()
  ? {}
  : { [PACKAGE as string]: path.resolve(__dirname, NOOP_MODULE as string) };

// Same for the optional Firestore SDK. No test resolves it today — the store is
// exercised through its FirestoreLike port with an in-memory fake — but one that
// reached the real factory would otherwise fail with a module-resolution error
// instead of the stub's refusal, which is the behaviour under test.
const {
  PACKAGE: FIRESTORE_PACKAGE,
  NOOP_MODULE: FIRESTORE_STUB,
  firestoreInstalled,
} = createRequire(import.meta.url)("./firestore-optional.cjs");

const firestoreAlias: Record<string, string> = firestoreInstalled()
  ? {}
  : { [FIRESTORE_PACKAGE as string]: path.resolve(__dirname, FIRESTORE_STUB as string) };

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    // Default environment is node. A React component test that needs the DOM
    // opts in per-file with a `// @vitest-environment jsdom` docblock.
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/components/ui/**", // shadcn-generated, low value
      ],
      // Real line/statement coverage is <1% (most src files have no unit tests
      // yet). Thresholds are omitted until the suite grows — add them back once
      // lines + statements are reliably above 10%.
      // TODO(ISV-labs): ratchet up when coverage improves
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      ...telemetryAlias,
      ...firestoreAlias,
    },
  },
});
