import { defineConfig } from "vite"

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.js"],
    environment: "node",
    include: ["src/**/*.test.{js,jsx}", "backend/tests/**/*.test.{js,mjs}"],
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

