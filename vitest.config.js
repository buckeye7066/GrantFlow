import { defineConfig } from "vite"

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.js"],
    environment: "node",
    // Exclude backend/tests/*.test.js (supertest resolution fails in Vitest on some setups); run via tests/unit/ or node
    include: ["src/**/*.test.{js,jsx}"],
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

