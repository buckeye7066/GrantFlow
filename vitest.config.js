import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.js"],
    environment: "node",
    include: ["backend/**/*.test.{js,mjs}", "src/**/*.test.{js,jsx}"],
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

