import { defineConfig, configDefaults } from "vitest/config"
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
    // Integration suites boot the app via testServer.getAppAndDb(), whose
    // `import("../server.js")` pulls in the full route/service graph. On slower
    // machines (Windows FS, cold module cache) that first import alone can take
    // 10s+, tripping Vitest's DEFAULT 10s hookTimeout in beforeAll — a known
    // intermittent flake class (see the comment in backend/tests/testServer.js).
    // 60s keeps genuine hangs caught while giving the one-time boot headroom.
    // (Was 30s. Under a full 663-file run four integration files —
    // authMeIdentityGate, profileSectionsArrayShape, profileWorkspaceStepCounts,
    // and the adversarialRepair/anyaAutoRepair pair — blew the 30s beforeAll on
    // server-boot import time alone, then passed standalone in seconds. The
    // bound is a hang detector, not a performance budget; doubling it does not
    // relax a single assertion.)
    hookTimeout: 60000,
    // Same "known intermittent flake class" one line up, but for individual
    // tests rather than beforeAll hooks: a handful of files load their module
    // graph via top-level `await import(...)` OUTSIDE any hook (e.g.
    // hamiltonFullProposalGenerator.test.js), so a cold-cache/contended full-
    // suite run can occasionally blow Vitest's 5s testTimeout default on pure
    // import time alone, with zero relation to the test's own logic (confirmed
    // hermetic — in-memory SQLite, stubbed LLM, no network/timers — and passes
    // reliably standalone). 15s mirrors the hookTimeout bump's own reasoning:
    // headroom for legitimate slow imports under load, not a looser bar for
    // actual hangs.
    //
    // RAISED 15s -> 45s on MEASURED evidence (2026-08-20), because 15s was not
    // headroom, it was a coin flip. Timed on an otherwise-idle machine with
    // --reporter=verbose:
    //   adversarialRepairSettings "403 for a NON-owner admin; …"  16130ms
    //   hamiltonPacketBilingual (4 cases, each boots the packet
    //     generator + translation path)                     9539-11493ms
    //   anyaAutoRepairService "reports Anya code-error repair
    //     policy on every run" (walks the live source tree)   ~13000ms
    // The first one is already OVER the old limit with nothing else running, so
    // it could only ever pass by luck; the rest cleared it by 3.5s or less and
    // failed the moment the full suite contended for CPU. None of them hangs —
    // all are hermetic and all pass standalone. 45s is ~2.8x the measured worst
    // case: still far short of "a hung test finishes the run", which is the only
    // thing this bound exists to catch.
    testTimeout: 45000,
    // The OTP full-app family (backend/tests/otp*.test.js +
    // emailOtpTokenNoVerifier.test.js) is the worst member of that same class:
    // its tests race their OWN parallel requests in-process (the security
    // property under test), so cross-FILE parallelism adds only CPU-starvation
    // noise — under full-suite load a rotating member flakes (correct code
    // 400s, a just-minted row reads as absent) while every serial run is
    // green. `npm run unit` therefore runs the bulk suite with that family
    // excluded, then the family serially (--no-file-parallelism); in-file
    // concurrency coverage is unchanged. Keep the two lists in package.json's
    // `unit` script in sync with this comment.
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
    // endpointSweep boots the FULL server and probes 327 live handlers, which
    // triggers their fire-and-forget side effects (telemetry/log writes) — an
    // integration gate, not a deterministic fast unit test. Run it via
    // `npm run test:endpoints` (and release:gates), not the parallel `unit`
    // lane where its post-completion async surfaced as flaky worker errors.
    exclude: [...configDefaults.exclude, "backend/tests/endpointSweep.test.js"],
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

