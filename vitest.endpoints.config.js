import { defineConfig } from "vitest/config"
import path from "node:path"

// Dedicated config for the endpoint-sweep INTEGRATION gate. It boots the full
// server and probes every GET handler, so it is intentionally NOT part of the
// parallel fast `unit` lane (where its post-completion fire-and-forget side
// effects surfaced as flaky worker errors). Run via `npm run test:endpoints`
// and from scripts/release-gates.mjs.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
    extensions: [".mjs", ".js", ".jsx", ".ts", ".tsx", ".json"],
  },
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.js"],
    environment: "node",
    include: ["backend/tests/endpointSweep.test.js"],
    passWithNoTests: false,
  },
})
