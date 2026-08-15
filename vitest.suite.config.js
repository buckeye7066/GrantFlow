import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'backend/tests/migration.harness.test.js',
      'backend/tests/tenantIsolation.test.js',
      'backend/tests/connectorContract.test.js',
      'backend/tests/dedupRegression.test.js',
      'backend/tests/eligibilityGate.test.js',
      'backend/tests/scoringStability.test.js',
      'backend/tests/aiGrounding.test.js',
      'backend/tests/queueFailure.test.js',
    ],
    reporters: ['default'],
    testTimeout: 30000,
    hookTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,
  },
});
