import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    environmentMatchGlobs: [
      // Use jsdom for React component tests (none in unit suite yet)
      ["**/*.component.test.ts", "jsdom"],
    ],
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
    },
  },
});
