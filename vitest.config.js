import { defineConfig } from "vite"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
    extensions: [".mjs", ".js", ".jsx", ".ts", ".tsx", ".json"],
  },
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.js"],
    environment: "node",
    // Runner ownership is split by extension to keep the two test runners on
    // disjoint file sets:
    //   - `tests/unit/**/*.test.mjs` are node:test suites (import { test } from
    //     'node:test') run by scripts/run-unit-tests.mjs — Vitest must NOT
    //     collect them, or their lazy dynamic imports (e.g. matchEngine ->
    //     zipcodes) blow up under Vitest's module runner with
    //     EnvironmentTeardownError.
    //   - `tests/unit/**/*.test.js` are Vitest-native (expect/globals) and
    //     belong to Vitest only.
    include: ["src/**/*.test.{js,jsx}", "backend/tests/**/*.test.{js,mjs}", "tests/unit/**/*.test.js"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      exclude: [
        "**/dist/**",
        "**/node_modules/**",
        "**/test-results/**",
        "**/*.config.*",
        "backend/data/**",
        "scripts/**",
      ],
    },
  },
})

